// Routy účtu v aplikaci: start/callback přihlášení přes vlastní OIDC, odhlášení, profil, heslo.
import { zobrazitDevKod } from '../../lib/sms/presmerovani.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bezDiakritiky, normalizujEmail } from '../../lib/kontakty.js';
import { overHeslo } from '../../lib/krypto.js';
import { hlidejLimit } from '../../lib/limit.js';
import { zapisAudit } from '../../lib/audit.js';
import { autorizacniUrl, type OidcKlient } from './oidc/klient.js';
import { vyzadujPrihlaseni } from './opravneni.js';
import type { UctySluzba } from './sluzba.js';

/** jak dlouho platí čerstvé ověření (staré heslo / SMS kód) pro citlivé změny */
export const OVERENI_PLATNOST_MS = 10 * 60_000;
// kam smí ověření pokračovat (jen stránky citlivých změn)
const CILE_OVERENI = ['/ucet/email', '/ucet/heslo'];

interface Zavislosti {
  klient: OidcKlient;
  ucty: UctySluzba;
}

// kam se smí po přihlášení vrátit — jen vlastní cesty (ochrana před open redirect)
function bezpecnaCesta(zpet: unknown): string {
  const s = String(zpet ?? '');
  return /^\/(?!\/)/.test(s) ? s : '/ucet';
}

export default async function uctyRoutes(app: FastifyInstance, z: Zavislosti) {
  const { klient, ucty } = z;
  const t = app.t;

  app.get<{ Querystring: { zpet?: string } }>('/prihlaseni', async (req, reply) => {
    if (req.uzivatel) return reply.redirect(bezpecnaCesta(req.query.zpet));
    const s = klient.zacniPrihlaseni();
    req.session.oidc = {
      state: s.state,
      nonce: s.nonce,
      verifier: s.verifier,
      zpet: bezpecnaCesta(req.query.zpet),
    };
    return reply.redirect(await autorizacniUrl(klient, s));
  });

  app.get('/prihlaseni/callback', async (req, reply) => {
    const ulozeno = req.session.oidc;
    if (!ulozeno) return reply.redirect('/prihlaseni');
    delete req.session.oidc;
    const url = new URL(req.url, app.env.BASE_URL);
    if (url.searchParams.get('error')) {
      req.session.flash = {
        typ: 'info',
        text: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? '',
      };
      return reply.redirect('/');
    }
    try {
      const v = await klient.dokonciPrihlaseni(url, ulozeno);
      const u = await ucty.podleId(v.sub);
      if (!u || u.blokovan_at) return reply.redirect('/');
      await req.session.regenerate();
      req.session.uzivatelId = u.id;
      req.session.idToken = v.idToken;
      return reply.redirect(ulozeno.zpet ?? '/ucet');
    } catch (e) {
      req.log.warn({ err: e }, 'OIDC callback selhal');
      req.session.flash = { typ: 'chyba', text: t('oidc.chyba') };
      return reply.redirect('/');
    }
  });

  // Odhlášení: smazat vlastní sezení a poslat na provider (RP-initiated logout) → odhlásí ze všech aplikací.
  app.post('/odhlaseni', async (req, reply) => {
    const idToken = req.session.idToken;
    const uid = req.uzivatel?.id;
    await req.session.destroy();
    if (uid) await zapisAudit(app.db, { uzivatelId: uid, akce: 'odhlaseni', ip: req.ip });
    return reply.redirect(klient.odhlasovaciUrl(idToken));
  });

  app.get('/ucet', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    const u = req.uzivatel!;
    let odber: { overen: boolean } | null = null;
    if (app.obec.moduly.infokanal) {
      const o = await app.db
        .selectFrom('ik_odberatele')
        .select(['overen_at', 'odhlasen_at'])
        .where('telefon', '=', u.telefon)
        .executeTakeFirst();
      if (o) odber = { overen: !!o.overen_at && !o.odhlasen_at };
    }
    return reply.view('ucty/ucet', { titulek: t('ucet.titulek'), u, odber });
  });

  app.post<{ Body: Record<string, string | undefined> }>(
    '/ucet',
    { preHandler: vyzadujPrihlaseni },
    async (req, reply) => {
      const b = req.body;
      const casti = app.obec.obec.casti;
      const castObce = casti.includes(String(b.cast_obce)) ? String(b.cast_obce) : '';
      await ucty.upravProfil(
        req.uzivatel!.id,
        {
          jmeno: String(b.jmeno ?? '')
            .trim()
            .slice(0, 100),
          prijmeni: String(b.prijmeni ?? '')
            .trim()
            .slice(0, 100),
          prezdivka: String(b.prezdivka ?? '')
            .trim()
            .slice(0, 60),
          cast_obce: castObce,
        },
        req.ip,
      );
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      return reply.redirect('/ucet');
    },
  );

  // ---------- Citlivé změny (e-mail, heslo): jen po čerstvém ověření ----------
  // Kdo se na chvíli dostane k cizí přihlášené relaci, nesmí si nastavit vlastní e-mail + heslo a získat
  // tak trvalý přístup. Proto: staré heslo, nebo nový SMS kód na telefon účtu; ověření platí 10 minut.

  const jeCerstve = (req: FastifyRequest) => (req.session.overenoDo ?? 0) > Date.now();
  const kOvereni = (dalsi: string) => `/ucet/overeni?dalsi=${encodeURIComponent(dalsi)}`;
  const vyzadujCerstve = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.uzivatel) return vyzadujPrihlaseni(req, reply);
    if (jeCerstve(req)) return;
    return reply.redirect(kOvereni(req.url.split('?')[0]!));
  };
  const dalsiKrok = (v: unknown) => {
    const s = String(v ?? '');
    return CILE_OVERENI.includes(s) ? s : '/ucet';
  };

  async function overeno(req: FastifyRequest, reply: FastifyReply, zpusob: 'heslo' | 'sms', dalsi: string) {
    req.session.overenoDo = Date.now() + OVERENI_PLATNOST_MS;
    await zapisAudit(app.db, {
      uzivatelId: req.uzivatel!.id,
      akce: 'ucet.overeni',
      detail: { zpusob },
      ip: req.ip,
    });
    return reply.redirect(dalsi);
  }

  function stranaOvereni(req: FastifyRequest, reply: FastifyReply, data: Record<string, unknown> = {}) {
    return reply.view('ucty/overeni', {
      titulek: t('overeni.titulek'),
      maHeslo: !!req.uzivatel!.heslo_hash,
      telefon: req.uzivatel!.telefon,
      dalsi: dalsiKrok(
        (req.query as Record<string, unknown>)?.dalsi ?? (req.body as Record<string, unknown>)?.dalsi,
      ),
      ...data,
    });
  }

  app.get('/ucet/overeni', { preHandler: vyzadujPrihlaseni }, async (req, reply) =>
    stranaOvereni(req, reply),
  );

  app.post<{ Body: { heslo?: string; dalsi?: string } }>(
    '/ucet/overeni/heslo',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.heslo)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      if (u.heslo_hash && (await overHeslo(String(req.body.heslo ?? ''), u.heslo_hash))) {
        return overeno(req, reply, 'heslo', dalsiKrok(req.body.dalsi));
      }
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.overeni_selhalo',
        detail: { zpusob: 'heslo' },
        ip: req.ip,
      });
      return stranaOvereni(req, reply, { chyba: t('overeni.heslo_spatne') });
    },
  );

  app.post<{ Body: { dalsi?: string } }>(
    '/ucet/overeni/sms',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.poslat)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      const v = await app.otp.vydej(u.telefon, 'zmena');
      if ('chyba' in v) return stranaOvereni(req, reply, { chyba: t('prihlaseni.limit') });
      try {
        await app.sms.posli(
          u.telefon,
          bezDiakritiky(
            `${app.obec.texty.sms_prefix}Kod pro zmenu uctu: ${v.kod} (plati 10 minut). Pokud jste o zmenu nezadali, kod nikomu nesdelujte.`,
          ),
        );
      } catch (e) {
        req.log.error({ err: e }, 'odeslání kódu pro změnu selhalo');
        return stranaOvereni(req, reply, { chyba: t('prihlaseni.odesilani_selhalo') });
      }
      return stranaOvereni(req, reply, {
        kodOdeslan: true,
        devKod: zobrazitDevKod(app.env, u.telefon) ? v.kod : null,
      });
    },
  );

  app.post<{ Body: { kod?: string; dalsi?: string } }>(
    '/ucet/overeni/kod',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.overit)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      if (await app.otp.over(u.telefon, 'zmena', String(req.body.kod ?? ''))) {
        return overeno(req, reply, 'sms', dalsiKrok(req.body.dalsi));
      }
      await zapisAudit(app.db, {
        uzivatelId: u.id,
        akce: 'ucet.overeni_selhalo',
        detail: { zpusob: 'sms' },
        ip: req.ip,
      });
      return stranaOvereni(req, reply, { kodOdeslan: true, chyba: t('prihlaseni.kod_nespravny') });
    },
  );

  // Po změně hesla/e-mailu: SMS na telefon účtu („nebyl jste to vy?“) a odhlášení všech ostatních sezení.
  async function poCitliveZmene(req: FastifyRequest, co: 'heslo' | 'email') {
    const u = req.uzivatel!;
    const text =
      co === 'heslo'
        ? `${app.obec.texty.sms_prefix}Na vasem uctu bylo zmeneno heslo. Pokud jste to nebyl(a) vy, ihned se ozvete obecnimu uradu${app.obec.obec.kontakt.telefon ? ' (' + app.obec.obec.kontakt.telefon + ')' : ''}.`
        : `${app.obec.texty.sms_prefix}Na vasem uctu byl zmenen e-mail. Pokud jste to nebyl(a) vy, ihned se ozvete obecnimu uradu${app.obec.obec.kontakt.telefon ? ' (' + app.obec.obec.kontakt.telefon + ')' : ''}.`;
    try {
      await app.sms.posli(u.telefon, bezDiakritiky(text));
    } catch (e) {
      req.log.error({ err: e, uzivatel: u.id }, 'upozornění na změnu účtu se nepodařilo odeslat');
    }
    const n = await ucty.odhlasOstatni(u.id, req.session.sessionId);
    await zapisAudit(app.db, {
      uzivatelId: u.id,
      akce: 'ucet.odhlaseni_ostatnich',
      detail: { duvod: co, sezeni: n },
      ip: req.ip,
    });
  }

  // --- e-mail ---
  app.get('/ucet/email', { preHandler: vyzadujCerstve }, async (req, reply) =>
    reply.view('ucty/email', { titulek: t('zmena_emailu.titulek'), u: req.uzivatel! }),
  );

  app.post<{ Body: { email?: string; akce?: string } }>(
    '/ucet/email',
    { preHandler: [vyzadujCerstve, hlidejLimit(app.limity.poslat)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      if (req.body.akce === 'odebrat') {
        if (!u.email) return reply.redirect('/ucet');
        await ucty.odeberEmail(u.id, req.ip);
        await poCitliveZmene(req, 'email');
        req.session.flash = { typ: 'ok', text: t('zmena_emailu.odebran') };
        return reply.redirect('/ucet');
      }
      const email = normalizujEmail(req.body.email);
      const vykresli = (chyba: string) =>
        reply.view('ucty/email', { titulek: t('zmena_emailu.titulek'), u, chyba, email: req.body.email });
      if (!email) return vykresli(t('zmena_emailu.neplatny'));
      const v = await ucty.zadostOEmail(u.id, email, req.ip);
      if ('chyba' in v)
        return vykresli(v.chyba === 'stejny' ? t('zmena_emailu.stejny') : t('ucet.email_obsazeny'));
      const kod = await app.otp.vydej(email, 'email');
      if ('chyba' in kod) return vykresli(t('prihlaseni.limit'));
      try {
        await app.mail.posli({
          komu: email,
          predmet: t('zmena_emailu.mail_predmet', { obec: app.obec.obec.nazev }),
          text: t('zmena_emailu.mail_text', { kod: kod.kod, obec: app.obec.obec.nazev }),
        });
      } catch (e) {
        req.log.error({ err: e }, 'e-mail s kódem se nepodařilo odeslat');
        return vykresli(t('zmena_emailu.odesilani_selhalo'));
      }
      return reply.view('ucty/email-kod', {
        titulek: t('zmena_emailu.titulek'),
        email,
        devKod: zobrazitDevKod(app.env, u.telefon) ? kod.kod : null,
      });
    },
  );

  // Potvrzení kódem z nového e-mailu. Čerstvé ověření tu už nevyžadujeme (kód ověřuje vlastnictví schránky),
  // ale e-mail čekající na potvrzení mohl založit jen ten, kdo se čerstvě ověřil.
  app.post<{ Body: { kod?: string } }>(
    '/ucet/email/potvrdit',
    { preHandler: [vyzadujPrihlaseni, hlidejLimit(app.limity.overit)] },
    async (req, reply) => {
      const u = req.uzivatel!;
      const email = u.email_cekajici;
      if (!email) return reply.redirect('/ucet');
      if (!(await app.otp.over(email, 'email', String(req.body.kod ?? '')))) {
        return reply.view('ucty/email-kod', {
          titulek: t('zmena_emailu.titulek'),
          email,
          chyba: t('prihlaseni.kod_nespravny'),
        });
      }
      const v = await ucty.potvrdEmail(u.id, req.ip);
      if ('chyba' in v) {
        req.session.flash = { typ: 'chyba', text: t('ucet.email_obsazeny') };
        return reply.redirect('/ucet');
      }
      await poCitliveZmene(req, 'email');
      req.session.flash = { typ: 'ok', text: t('zmena_emailu.hotovo', { email: v.email }) };
      return reply.redirect('/ucet');
    },
  );

  app.get('/ucet/email/potvrdit', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    const email = req.uzivatel!.email_cekajici;
    if (!email) return reply.redirect('/ucet');
    return reply.view('ucty/email-kod', { titulek: t('zmena_emailu.titulek'), email });
  });

  app.post('/ucet/email/zrusit', { preHandler: vyzadujPrihlaseni }, async (req, reply) => {
    await ucty.zrusCekajiciEmail(req.uzivatel!.id);
    return reply.redirect('/ucet');
  });

  // --- heslo ---
  app.get('/ucet/heslo', { preHandler: vyzadujCerstve }, async (req, reply) =>
    reply.view('ucty/heslo-zmena', { titulek: t('ucet.heslo_titulek'), u: req.uzivatel! }),
  );

  app.post<{ Body: { heslo?: string; heslo2?: string } }>(
    '/ucet/heslo',
    { preHandler: vyzadujCerstve },
    async (req, reply) => {
      const u = req.uzivatel!;
      const heslo = String(req.body.heslo ?? '');
      const vykresli = (chyba: string) =>
        reply.view('ucty/heslo-zmena', { titulek: t('ucet.heslo_titulek'), u, chyba });
      if (!u.email) return vykresli(t('ucet.heslo_vyzaduje_email'));
      if (heslo.length < 10) return vykresli(t('ucet.heslo_kratke'));
      if (req.body.heslo2 !== undefined && req.body.heslo2 !== heslo)
        return vykresli(t('ucet.heslo_nesouhlasi'));
      await ucty.nastavHeslo(u.id, heslo, req.ip);
      await poCitliveZmene(req, 'heslo');
      req.session.flash = { typ: 'ok', text: t('ucet.heslo_ulozeno') };
      return reply.redirect('/ucet');
    },
  );
}
