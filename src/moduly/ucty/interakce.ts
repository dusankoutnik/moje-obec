// Přihlašovací obrazovky OIDC providera (interakce) = JEDINÝ přihlašovací dialog pro web i aplikace
// (rezervace, eKnihy): na jedné stránce telefon → SMS kód, e-mail + heslo, nebo „Neznám heslo“ → kód na e-mail.
// Po přihlášení GDPR souhlas a POVINNÉ jméno a příjmení (účet bez jména se dál nedostane, pokyn 2026-10-30);
// souhlas s přístupem pro cizí aplikace. Provider sem posílá KAŽDÉ přihlášení (i z externích aplikací).
import { zobrazitDevKod } from '../../lib/sms/presmerovani.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import type { InteractionResults } from 'oidc-provider';
import { normalizujEmail, normalizujTelefon, formatujTelefon, bezDiakritiky } from '../../lib/kontakty.js';
import { zapisAudit } from '../../lib/audit.js';
import { hlidejLimit } from '../../lib/limit.js';
import { bezJmena, ctiJmeno, type UctySluzba } from './sluzba.js';
import { OIDC_PREFIX, ROZSAHY } from './oidc/provider.js';

type Amr = 'sms' | 'pwd' | 'email';

interface Zavislosti {
  provider: Provider;
  ucty: UctySluzba;
}

export default async function interakceRoutes(app: FastifyInstance, z: Zavislosti) {
  const { provider, ucty } = z;
  const t = app.t;

  // Dokončení interakce: provider sám pošle přesměrování (hijack = Fastify do odpovědi nesahá).
  async function dokonci(req: FastifyRequest, reply: FastifyReply, vysledek: InteractionResults) {
    reply.hijack();
    await provider.interactionFinished(req.raw, reply.raw, vysledek, { mergeWithLastSubmission: false });
  }

  async function detaily(req: FastifyRequest, reply: FastifyReply) {
    try {
      return await provider.interactionDetails(req.raw, reply.raw);
    } catch {
      return null;
    }
  }

  function chybaInterakce(reply: FastifyReply) {
    return reply.code(410).view('chyba', { status: 410, nadpis: t('oidc.chyba'), text: '' });
  }

  // Společný přihlašovací dialog (telefon vlevo, e-mail + heslo vpravo); chyba se ukáže u příslušné části.
  function dialog(
    reply: FastifyReply,
    uid: string,
    navic: { chyba?: string; chybaEmail?: string; telefon?: string; email?: string } = {},
  ) {
    return reply.view('ucty/prihlaseni', {
      titulek: t('prihlaseni.titulek'),
      uid,
      skriptPrihlaseni: true,
      ...navic,
    });
  }

  // Po přihlášení: bez GDPR souhlasu nejdřív souhlas, bez jména jméno, pak teprve provider pustí dál.
  async function poPrihlaseni(
    req: FastifyRequest,
    reply: FastifyReply,
    uid: string,
    uzivatelId: string,
    amr: Amr,
  ) {
    const u = await ucty.podleId(uzivatelId);
    if (!u) return chybaInterakce(reply);
    if (u.blokovan_at) return dialog(reply, uid, { chyba: t('prihlaseni.blokovan') });
    await zapisAudit(app.db, { uzivatelId: u.id, akce: 'prihlaseni', detail: { zpusob: amr }, ip: req.ip });
    if (!u.gdpr_souhlas_at) {
      req.session.cekaSouhlas = { interakce: uid, uzivatelId: u.id, amr };
      return reply.view('ucty/souhlas', { titulek: t('souhlas.titulek'), uid });
    }
    return poSouhlasu(req, reply, uid, u.id, amr);
  }

  // Jméno a příjmení jsou povinné na KAŽDÉ cestě přihlášení (SMS kód, e-mail + heslo, e-mail + kód):
  // účet založený kódem z neznámého telefonu vzniká bez jména a člověk se bez něj dál nedostane.
  async function poSouhlasu(
    req: FastifyRequest,
    reply: FastifyReply,
    uid: string,
    uzivatelId: string,
    amr: Amr,
  ) {
    const u = await ucty.podleId(uzivatelId);
    if (!u) return chybaInterakce(reply);
    if (bezJmena(u)) {
      req.session.cekaJmeno = { interakce: uid, uzivatelId: u.id, amr };
      return reply.view('ucty/jmeno', {
        titulek: t('jmeno.titulek'),
        akce: `${OIDC_PREFIX}/interaction/${uid}/jmeno`,
        u,
      });
    }
    return dokonci(req, reply, { login: { accountId: u.id, amr: [amr], remember: true } });
  }

  app.get<{ Params: { uid: string } }>(`${OIDC_PREFIX}/interaction/:uid`, async (req, reply) => {
    const d = await detaily(req, reply);
    if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
    if (d.prompt.name === 'consent') {
      const klient = await provider.Client.find(String(d.params.client_id));
      const rozsahy = String(d.params.scope ?? 'openid')
        .split(' ')
        .filter((s) => (ROZSAHY as readonly string[]).includes(s));
      return reply.view('ucty/oidc-souhlas', {
        titulek: t('oidc.souhlas_titulek'),
        uid: d.uid,
        klient: klient?.clientName ?? String(d.params.client_id),
        rozsahy,
      });
    }
    return dialog(reply, d.uid);
  });

  // ---------- 1) telefon → SMS kód ----------
  app.post<{ Params: { uid: string }; Body: { telefon?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/telefon`,
    { preHandler: hlidejLimit(app.limity.poslat) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const telefon = normalizujTelefon(req.body.telefon);
      if (!telefon)
        return dialog(reply, d.uid, { chyba: t('prihlaseni.telefon_neplatny'), telefon: req.body.telefon });
      const v = await app.otp.vydej(telefon, 'prihlaseni');
      if ('chyba' in v)
        return dialog(reply, d.uid, { chyba: t('prihlaseni.limit'), telefon: req.body.telefon });
      try {
        await app.sms.posli(
          telefon,
          bezDiakritiky(`${app.obec.texty.sms_prefix}Prihlasovaci kod: ${v.kod} (plati 10 minut)`),
        );
      } catch (e) {
        req.log.error({ err: e }, 'odeslání OTP selhalo');
        return dialog(reply, d.uid, { chyba: t('prihlaseni.odesilani_selhalo'), telefon: req.body.telefon });
      }
      return reply.view('ucty/kod', {
        titulek: t('prihlaseni.titulek'),
        uid: d.uid,
        kanal: 'sms',
        telefon,
        telefonZobrazeny: formatujTelefon(telefon),
        devKod: zobrazitDevKod(app.env, telefon) ? v.kod : null,
      });
    },
  );

  // kód z SMS → přihlášení (účet vznikne, pokud neexistuje — bez jména, to si vyžádá brána níže)
  app.post<{ Params: { uid: string }; Body: { telefon?: string; kod?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/kod`,
    { preHandler: hlidejLimit(app.limity.overit) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const telefon = normalizujTelefon(req.body.telefon);
      if (!telefon) return dialog(reply, d.uid, { chyba: t('prihlaseni.telefon_neplatny') });
      const ok = await app.otp.over(telefon, 'prihlaseni', String(req.body.kod ?? ''));
      if (!ok) {
        return reply.view('ucty/kod', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          kanal: 'sms',
          telefon,
          telefonZobrazeny: formatujTelefon(telefon),
          chyba: t('prihlaseni.kod_nespravny'),
        });
      }
      // blokaci prozradíme až majiteli telefonu (po správném kódu), ne komukoliv, kdo číslo zadá
      const existujici = await ucty.podleTelefonu(telefon);
      if (existujici?.blokovan_at) return dialog(reply, d.uid, { chyba: t('prihlaseni.blokovan') });
      const { uzivatel } = await ucty.najdiNeboZaloz(telefon, req.ip);
      return poPrihlaseni(req, reply, d.uid, uzivatel.id, 'sms');
    },
  );

  // ---------- 2) e-mail + heslo ----------
  // Dřív samostatná stránka; teď je vše v jednom dialogu (starý odkaz vede tam).
  app.get<{ Params: { uid: string } }>(`${OIDC_PREFIX}/interaction/:uid/heslo`, async (req, reply) =>
    reply.redirect(`${OIDC_PREFIX}/interaction/${encodeURIComponent(req.params.uid)}`),
  );
  app.post<{ Params: { uid: string }; Body: { email?: string; heslo?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/heslo`,
    { preHandler: hlidejLimit(app.limity.heslo) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const email = normalizujEmail(req.body.email);
      const v = email
        ? await ucty.prihlasHeslemSeZamkem(email, String(req.body.heslo ?? ''), req.ip)
        : ({ chyba: 'heslo' } as const);
      if ('chyba' in v) {
        await zapisAudit(app.db, {
          akce: 'prihlaseni.selhalo',
          detail: { email: email ?? '?', ...(v.chyba === 'zamceno' ? { zamceno: true } : {}) },
          ip: req.ip,
        });
        return dialog(reply, d.uid, {
          chybaEmail: t(v.chyba === 'zamceno' ? 'prihlaseni.heslo_zamceno' : 'prihlaseni.heslo_spatne'),
          email: req.body.email,
        });
      }
      return poPrihlaseni(req, reply, d.uid, v.uzivatel.id, 'pwd');
    },
  );

  // ---------- 3) „Neznám heslo“: kód na e-mail ----------
  // Odpověď je stejná pro známý i neznámý e-mail (nikdo si nevyčte, kdo má účet); kód jde jen existujícímu,
  // neblokovanému účtu. Neznámý e-mail účet NEZAKLÁDÁ — kotvou účtu je telefon.
  app.post<{ Params: { uid: string }; Body: { email?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/email-kod`,
    { preHandler: hlidejLimit(app.limity.poslat) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const email = normalizujEmail(req.body.email);
      if (!email)
        return dialog(reply, d.uid, { chybaEmail: t('prihlaseni.email_neplatny'), email: req.body.email });
      const u = await ucty.podleEmailu(email);
      let devKod: string | null = null;
      if (u && !u.blokovan_at) {
        const v = await app.otp.vydej(email, 'prihlaseni');
        if (!('chyba' in v)) {
          try {
            await app.mail.posli({
              komu: email,
              predmet: t('prihlaseni.email_kod_predmet', { obec: app.obec.obec.nazev }),
              text: t('prihlaseni.email_kod_text', { kod: v.kod, obec: app.obec.obec.nazev }),
            });
            devKod = zobrazitDevKod(app.env, u.telefon) ? v.kod : null;
          } catch (e) {
            req.log.error({ err: e }, 'e-mail s přihlašovacím kódem se nepodařilo odeslat');
          }
        }
      }
      return reply.view('ucty/kod', {
        titulek: t('prihlaseni.titulek'),
        uid: d.uid,
        kanal: 'email',
        email,
        devKod,
      });
    },
  );
  app.post<{ Params: { uid: string }; Body: { email?: string; kod?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/email-overit`,
    { preHandler: hlidejLimit(app.limity.overit) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const email = normalizujEmail(req.body.email);
      if (!email) return dialog(reply, d.uid, { chybaEmail: t('prihlaseni.email_neplatny') });
      const ok = await app.otp.over(email, 'prihlaseni', String(req.body.kod ?? ''));
      const u = ok ? await ucty.podleEmailu(email) : undefined;
      if (!u) {
        return reply.view('ucty/kod', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          kanal: 'email',
          email,
          chyba: t('prihlaseni.kod_nespravny'),
        });
      }
      return poPrihlaseni(req, reply, d.uid, u.id, 'email');
    },
  );

  // ---------- GDPR souhlas (po prvním přihlášení) ----------
  app.post<{ Params: { uid: string }; Body: { souhlas?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/souhlas`,
    async (req, reply) => {
      const d = await detaily(req, reply);
      const ceka = req.session.cekaSouhlas;
      if (!d || d.uid !== req.params.uid || !ceka || ceka.interakce !== d.uid) return chybaInterakce(reply);
      delete req.session.cekaSouhlas;
      if (req.body.souhlas !== 'ano')
        return dokonci(req, reply, {
          error: 'access_denied',
          error_description: 'Bez souhlasu nelze účet používat.',
        });
      await ucty.udelSouhlas(ceka.uzivatelId, req.ip);
      return poSouhlasu(req, reply, d.uid, ceka.uzivatelId, ceka.amr ?? 'sms');
    },
  );

  // ---------- jméno a příjmení (povinné; účet bez nich se do aplikací nedostane) ----------
  app.post<{ Params: { uid: string }; Body: Record<string, string | undefined> }>(
    `${OIDC_PREFIX}/interaction/:uid/jmeno`,
    async (req, reply) => {
      const d = await detaily(req, reply);
      const ceka = req.session.cekaJmeno;
      if (!d || d.uid !== req.params.uid || !ceka || ceka.interakce !== d.uid) return chybaInterakce(reply);
      const jm = ctiJmeno(req.body);
      if (!jm) {
        const u = await ucty.podleId(ceka.uzivatelId);
        return reply.view('ucty/jmeno', {
          titulek: t('jmeno.titulek'),
          akce: `${OIDC_PREFIX}/interaction/${d.uid}/jmeno`,
          u: { ...u, jmeno: String(req.body.jmeno ?? ''), prijmeni: String(req.body.prijmeni ?? '') },
          chyba: t('jmeno.chyba'),
        });
      }
      delete req.session.cekaJmeno;
      await ucty.doplnJmeno(ceka.uzivatelId, jm, req.ip);
      return dokonci(req, reply, { login: { accountId: ceka.uzivatelId, amr: [ceka.amr], remember: true } });
    },
  );

  // souhlas s přístupem pro aplikaci (jen klienti, kteří nejsou duveryhodni)
  app.post<{ Params: { uid: string }; Body: { rozhodnuti?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/pristup`,
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid || d.prompt.name !== 'consent') return chybaInterakce(reply);
      if (req.body.rozhodnuti !== 'povolit')
        return dokonci(req, reply, { error: 'access_denied', error_description: 'Uživatel přístup odmítl.' });
      const accountId = d.session?.accountId;
      if (!accountId) return chybaInterakce(reply);
      let grant = d.grantId ? await provider.Grant.find(d.grantId) : undefined;
      if (!grant) grant = new provider.Grant({ accountId, clientId: String(d.params.client_id) });
      const detaily2 = d.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] };
      if (detaily2.missingOIDCScope) grant.addOIDCScope(detaily2.missingOIDCScope.join(' '));
      if (detaily2.missingOIDCClaims) grant.addOIDCClaims(detaily2.missingOIDCClaims);
      const grantId = await grant.save();
      await zapisAudit(app.db, {
        uzivatelId: accountId,
        akce: 'oidc.souhlas',
        detail: { klient: d.params.client_id, rozsah: d.params.scope },
        ip: req.ip,
      });
      return dokonci(req, reply, { consent: { grantId } });
    },
  );

  app.get<{ Params: { uid: string } }>(`${OIDC_PREFIX}/interaction/:uid/zrusit`, async (req, reply) => {
    const d = await detaily(req, reply);
    if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
    return dokonci(req, reply, { error: 'access_denied', error_description: 'Přihlášení zrušeno.' });
  });
}
