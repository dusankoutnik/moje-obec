// Veřejné routy infokanálu: přihlášení k odběru (OTP), správa odběru, odhlášení odkazem.
import { zobrazitDevKod } from '../../lib/sms/presmerovani.js';
import type { FastifyInstance } from 'fastify';
import type { KanalPreference } from '../../db/types.js';
import { normalizujEmail, normalizujTelefon, formatujTelefon, bezDiakritiky } from '../../lib/kontakty.js';
import type { InfokanalSluzba } from './sluzba.js';
import { hlidejLimit } from '../../lib/limit.js';

const KANALY: KanalPreference[] = ['sms', 'smisene', 'email'];

/** údaje z přihlášky k odběru, které se uloží až po ověření kódu (do té doby jsou jen v sezení) */
interface CekajiciOdber {
  telefon: string;
  jmeno: string;
  email: string | null;
  castObce: string;
  kanal: KanalPreference;
  optouty: number[];
  do: number;
}

declare module 'fastify' {
  interface Session {
    odberCeka?: CekajiciOdber;
  }
}

function poleCisel(v: unknown): number[] {
  const arr = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return arr.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export default async function infokanalRoutes(app: FastifyInstance, z: { sluzba: InfokanalSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const ODBER_PLATNOST_MS = 30 * 60_000;

  function aktualniOdber(req: {
    session: { odber?: { odberatelId: string; do: number } };
    uzivatel: { telefon: string } | null;
  }) {
    if (req.session.odber && req.session.odber.do > Date.now())
      return { id: req.session.odber.odberatelId, zPrihlaseni: false };
    return null;
  }

  app.get('/infokanal', async (req, reply) => {
    const kategorie = await sluzba.kategorie();
    // přihlášený uživatel: předvyplnit z účtu, nebo rovnou do správy odběru, pokud už odebírá
    let predvyplneno: Record<string, string> = {};
    if (req.uzivatel) {
      const o = await sluzba.odberatelPodleTelefonu(req.uzivatel.telefon);
      if (o && o.overen_at && !o.odhlasen_at) {
        req.session.odber = { odberatelId: o.id, do: Date.now() + ODBER_PLATNOST_MS };
        return reply.redirect('/infokanal/odber');
      }
      predvyplneno = {
        jmeno: `${req.uzivatel.jmeno} ${req.uzivatel.prijmeni}`.trim(),
        telefon: formatujTelefon(req.uzivatel.telefon),
        email: req.uzivatel.email ?? '',
        cast_obce: req.uzivatel.cast_obce,
      };
    }
    return reply.view('infokanal/index', {
      titulek: t('infokanal.titulek'),
      kategorie,
      f: predvyplneno,
      kanaly: KANALY,
    });
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/infokanal',
    { preHandler: hlidejLimit(app.limity.poslat) },
    async (req, reply) => {
      const b = req.body;
      const kategorie = await sluzba.kategorie();
      const vykresli = (chyba: string) =>
        reply.view('infokanal/index', {
          titulek: t('infokanal.titulek'),
          kategorie,
          f: b,
          kanaly: KANALY,
          chyba,
        });
      const telefon = normalizujTelefon(b.telefon);
      if (!telefon) return vykresli(t('prihlaseni.telefon_neplatny'));
      if (b.souhlas !== 'ano') return vykresli(t('infokanal.souhlas_nutny'));
      const email = String(b.email ?? '').trim() ? normalizujEmail(b.email) : null;
      const kanal = KANALY.includes(b.kanal as KanalPreference) ? (b.kanal as KanalPreference) : 'sms';
      const casti = app.obec.obec.casti;
      const castObce = casti.includes(String(b.cast_obce)) ? String(b.cast_obce) : '';
      const zvolene = new Set(poleCisel(b.kategorie));
      const optouty = kategorie.filter((k) => !k.povinna && !zvolene.has(k.id)).map((k) => k.id);

      const udaje = {
        jmeno: String(b.jmeno ?? '')
          .trim()
          .slice(0, 120),
        telefon,
        email,
        castObce,
        kanal: email ? kanal : ('sms' as KanalPreference),
        optouty,
      };
      // přihlášený uživatel se stejným telefonem = telefon už je ověřený kódem při přihlášení → bez dalšího OTP
      const zUctu = !!req.uzivatel && req.uzivatel.telefon === telefon;
      if (zUctu) {
        const { o, emailObsazeny } = await sluzba.zalozNeboObnov({
          ...udaje,
          zdroj: 'ucet',
          overeno: true,
          souhlas: true,
          uzivatelId: req.uzivatel!.id,
        });
        req.session.odber = { odberatelId: o.id, do: Date.now() + ODBER_PLATNOST_MS };
        req.session.flash = {
          typ: emailObsazeny ? 'info' : 'ok',
          text: t(emailObsazeny ? 'infokanal.email_obsazeny' : 'infokanal.potvrzeno'),
        };
        return reply.redirect('/infokanal/odber');
      }
      // Bez ověření kódem se v databázi nic nemění (ani u existujícího odběratele) — kdo zná cizí číslo,
      // nesmí odběr obnovit ani přesměrovat e-maily. Údaje počkají v sezení a uloží se po ověření kódu.
      const v = await app.otp.vydej(telefon, 'odber');
      if ('chyba' in v)
        return vykresli(
          t(
            v.chyba === 'predvolba'
              ? 'prihlaseni.predvolba'
              : v.chyba === 'rozpocet'
                ? 'prihlaseni.odesilani_selhalo'
                : 'prihlaseni.limit',
          ),
        );
      req.session.odberCeka = { ...udaje, do: Date.now() + ODBER_PLATNOST_MS };
      try {
        await app.sms.posli(
          telefon,
          bezDiakritiky(
            `${app.obec.texty.sms_prefix}Overovaci kod pro odber hlaseni: ${v.kod} (plati 10 minut)`,
          ),
        );
      } catch (e) {
        req.log.error({ err: e }, 'odeslání OTP odběru selhalo');
        return vykresli(t('prihlaseni.odesilani_selhalo'));
      }
      return reply.view('infokanal/overeni', {
        titulek: t('infokanal.overeni_titulek'),
        telefon,
        telefonZobrazeny: formatujTelefon(telefon),
        devKod: zobrazitDevKod(app.env, telefon) ? v.kod : null,
      });
    },
  );

  // správa existujícího odběru kódem (bez účtu)
  app.post<{ Body: { telefon?: string } }>(
    '/infokanal/kod',
    { preHandler: hlidejLimit(app.limity.poslat) },
    async (req, reply) => {
      const telefon = normalizujTelefon(req.body.telefon);
      const kategorie = await sluzba.kategorie();
      if (!telefon)
        return reply.view('infokanal/index', {
          titulek: t('infokanal.titulek'),
          kategorie,
          f: req.body,
          kanaly: KANALY,
          chyba: t('prihlaseni.telefon_neplatny'),
        });
      // Kód jde jen existujícímu odběrateli; odpověď je pro známé i neznámé číslo stejná
      // (žádný výčet odběratelů, žádné SMS na cizí čísla). Ověření neznámého čísla pak selže samo.
      const neutralni = () =>
        reply.view('infokanal/overeni', {
          titulek: t('infokanal.overeni_titulek'),
          telefon,
          telefonZobrazeny: formatujTelefon(telefon),
          neutralni: true,
          devKod: null,
        });
      if (!(await sluzba.odberatelPodleTelefonu(telefon))) return neutralni();
      // limit kontaktu ani chyba brány se navenek neliší od neznámého čísla (jinak by šlo zjistit, kdo odebírá)
      const v = await app.otp.vydej(telefon, 'odber');
      if ('chyba' in v) {
        req.log.info({ chyba: v.chyba }, 'kód pro správu odběru nevydán');
        return neutralni();
      }
      try {
        await app.sms.posli(
          telefon,
          bezDiakritiky(`${app.obec.texty.sms_prefix}Kod pro spravu odberu: ${v.kod} (plati 10 minut)`),
        );
      } catch (e) {
        req.log.error({ err: e }, 'odeslání kódu pro správu odběru selhalo');
        return neutralni();
      }
      return reply.view('infokanal/overeni', {
        titulek: t('infokanal.overeni_titulek'),
        telefon,
        telefonZobrazeny: formatujTelefon(telefon),
        neutralni: true,
        devKod: zobrazitDevKod(app.env, telefon) ? v.kod : null,
      });
    },
  );

  app.post<{ Body: { telefon?: string; kod?: string } }>(
    '/infokanal/overeni',
    { preHandler: hlidejLimit(app.limity.overit) },
    async (req, reply) => {
      const telefon = normalizujTelefon(req.body.telefon);
      if (!telefon) return reply.redirect('/infokanal');
      const ok = await app.otp.over(telefon, 'odber', String(req.body.kod ?? ''));
      let o = ok ? await sluzba.odberatelPodleTelefonu(telefon) : undefined;
      let emailObsazeny = false;
      // přihláška k odběru: teprve teď (telefon ověřen) se údaje z formuláře zapíšou
      const ceka = req.session.odberCeka;
      if (ok && ceka && ceka.telefon === telefon && ceka.do > Date.now()) {
        const byloOvereno = !!o?.overen_at && !o?.odhlasen_at;
        const v = await sluzba.zalozNeboObnov({
          jmeno: ceka.jmeno,
          telefon,
          email: ceka.email,
          castObce: ceka.castObce,
          kanal: ceka.kanal,
          optouty: ceka.optouty,
          zdroj: 'web',
          overeno: true,
          souhlas: true,
          uzivatelId: req.uzivatel?.telefon === telefon ? req.uzivatel.id : null,
        });
        o = v.o;
        emailObsazeny = v.emailObsazeny;
        delete req.session.odberCeka;
        req.session.odber = { odberatelId: o.id, do: Date.now() + ODBER_PLATNOST_MS };
        if (emailObsazeny) req.session.flash = { typ: 'info', text: t('infokanal.email_obsazeny') };
        else if (!byloOvereno) req.session.flash = { typ: 'ok', text: t('infokanal.potvrzeno') };
        else req.session.flash = { typ: 'ok', text: t('infokanal.kategorie_nastaveny') };
        return reply.redirect('/infokanal/odber');
      }
      if (!ok || !o) {
        return reply.view('infokanal/overeni', {
          titulek: t('infokanal.overeni_titulek'),
          telefon,
          telefonZobrazeny: formatujTelefon(telefon),
          chyba: t('prihlaseni.kod_nespravny'),
        });
      }
      const byloOvereno = !!o.overen_at && !o.odhlasen_at;
      await sluzba.over(o.id);
      req.session.odber = { odberatelId: o.id, do: Date.now() + ODBER_PLATNOST_MS };
      if (!byloOvereno) req.session.flash = { typ: 'ok', text: t('infokanal.potvrzeno') };
      return reply.redirect('/infokanal/odber');
    },
  );

  app.get('/infokanal/odber', async (req, reply) => {
    const a = aktualniOdber(req);
    if (!a) return reply.redirect('/infokanal');
    const o = await sluzba.odberatelPodleId(a.id);
    if (!o) return reply.redirect('/infokanal');
    const kategorie = await sluzba.kategorie();
    const optouty = new Set(await sluzba.optoutyOdberatele(o.id));
    return reply.view('infokanal/odber', {
      titulek: t('infokanal.odber_titulek'),
      o,
      kategorie,
      optouty,
      kanaly: KANALY,
    });
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/infokanal/odber',
    async (req, reply) => {
      const a = aktualniOdber(req);
      if (!a) return reply.redirect('/infokanal');
      const b = req.body;
      const kategorie = await sluzba.kategorie();
      const zvolene = new Set(poleCisel(b.kategorie));
      const optouty = kategorie.filter((k) => !k.povinna && !zvolene.has(k.id)).map((k) => k.id);
      const email = String(b.email ?? '').trim() ? normalizujEmail(b.email) : null;
      const kanal = KANALY.includes(b.kanal as KanalPreference) ? (b.kanal as KanalPreference) : 'sms';
      const casti = app.obec.obec.casti;
      await sluzba.uprav(
        a.id,
        {
          jmeno: String(b.jmeno ?? '')
            .trim()
            .slice(0, 120),
          email,
          castObce: casti.includes(String(b.cast_obce)) ? String(b.cast_obce) : '',
          kanal: email ? kanal : 'sms',
        },
        optouty,
      );
      req.session.flash = { typ: 'ok', text: t('infokanal.kategorie_nastaveny') };
      return reply.redirect('/infokanal/odber');
    },
  );

  app.post('/infokanal/odber/zrusit', async (req, reply) => {
    const a = aktualniOdber(req);
    if (!a) return reply.redirect('/infokanal');
    await sluzba.odhlas(a.id, 'web');
    delete req.session.odber;
    req.session.flash = { typ: 'info', text: t('infokanal.odhlaseno') };
    return reply.redirect('/infokanal');
  });

  // odhlášení odkazem z patičky e-mailu (GET ukáže potvrzení, POST provede)
  app.get<{ Params: { token: string } }>('/infokanal/odhlasit/:token', async (req, reply) => {
    const o = await sluzba.odberatelPodleTokenu(req.params.token);
    if (!o)
      return reply
        .code(404)
        .view('chyba', { status: 404, nadpis: t('infokanal.odhlaseni_neplatne'), text: '' });
    return reply.view('infokanal/odhlasit', { titulek: t('infokanal.odhlasit_titulek'), token: o.token, o });
  });
  app.post<{ Params: { token: string } }>('/infokanal/odhlasit/:token', async (req, reply) => {
    const o = await sluzba.odberatelPodleTokenu(req.params.token);
    if (!o)
      return reply
        .code(404)
        .view('chyba', { status: 404, nadpis: t('infokanal.odhlaseni_neplatne'), text: '' });
    await sluzba.odhlas(o.id, 'odkaz');
    req.session.flash = { typ: 'info', text: t('infokanal.odhlaseno') };
    return reply.redirect('/infokanal');
  });
}
