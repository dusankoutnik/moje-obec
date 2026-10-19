// Přihlašovací obrazovky OIDC providera (interakce): telefon → SMS kód, nebo e-mail + heslo; GDPR souhlas;
// souhlas s přístupem pro cizí aplikace. Provider sem posílá KAŽDÉ přihlášení (i z externích aplikací).
import { zobrazitDevKod } from '../../lib/sms/presmerovani.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Provider from 'oidc-provider';
import type { InteractionResults } from 'oidc-provider';
import { normalizujEmail, normalizujTelefon, formatujTelefon, bezDiakritiky } from '../../lib/kontakty.js';
import { zapisAudit } from '../../lib/audit.js';
import { hlidejLimit } from '../../lib/limit.js';
import type { UctySluzba } from './sluzba.js';
import { OIDC_PREFIX, ROZSAHY } from './oidc/provider.js';

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

  // Po přihlášení: bez GDPR souhlasu nejdřív souhlas, pak teprve provider pustí dál.
  async function poPrihlaseni(
    req: FastifyRequest,
    reply: FastifyReply,
    uid: string,
    uzivatelId: string,
    amr: string,
  ) {
    const u = await ucty.podleId(uzivatelId);
    if (!u) return chybaInterakce(reply);
    if (u.blokovan_at) {
      return reply.view('ucty/prihlaseni', {
        titulek: t('prihlaseni.titulek'),
        uid,
        chyba: t('prihlaseni.blokovan'),
      });
    }
    await zapisAudit(app.db, { uzivatelId: u.id, akce: 'prihlaseni', detail: { zpusob: amr }, ip: req.ip });
    if (!u.gdpr_souhlas_at) {
      req.session.cekaSouhlas = { interakce: uid, uzivatelId: u.id };
      return reply.view('ucty/souhlas', { titulek: t('souhlas.titulek'), uid });
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
    return reply.view('ucty/prihlaseni', { titulek: t('prihlaseni.titulek'), uid: d.uid });
  });

  // krok 1: telefon → SMS kód
  app.post<{ Params: { uid: string }; Body: { telefon?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/telefon`,
    { preHandler: hlidejLimit(app.limity.poslat) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const telefon = normalizujTelefon(req.body.telefon);
      if (!telefon) {
        return reply.view('ucty/prihlaseni', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          chyba: t('prihlaseni.telefon_neplatny'),
          telefon: req.body.telefon,
        });
      }
      const v = await app.otp.vydej(telefon, 'prihlaseni');
      if ('chyba' in v) {
        return reply.view('ucty/prihlaseni', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          chyba: t('prihlaseni.limit'),
          telefon: req.body.telefon,
        });
      }
      try {
        await app.sms.posli(
          telefon,
          bezDiakritiky(`${app.obec.texty.sms_prefix}Prihlasovaci kod: ${v.kod} (plati 10 minut)`),
        );
      } catch (e) {
        req.log.error({ err: e }, 'odeslání OTP selhalo');
        return reply.view('ucty/prihlaseni', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          chyba: t('prihlaseni.odesilani_selhalo'),
          telefon: req.body.telefon,
        });
      }
      return reply.view('ucty/kod', {
        titulek: t('prihlaseni.titulek'),
        uid: d.uid,
        telefon,
        telefonZobrazeny: formatujTelefon(telefon),
        devKod: zobrazitDevKod(app.env, telefon) ? v.kod : null,
      });
    },
  );

  // krok 2: kód → přihlášení (účet vznikne, pokud neexistuje)
  app.post<{ Params: { uid: string }; Body: { telefon?: string; kod?: string } }>(
    `${OIDC_PREFIX}/interaction/:uid/kod`,
    { preHandler: hlidejLimit(app.limity.overit) },
    async (req, reply) => {
      const d = await detaily(req, reply);
      if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
      const telefon = normalizujTelefon(req.body.telefon);
      if (!telefon)
        return reply.view('ucty/prihlaseni', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          chyba: t('prihlaseni.telefon_neplatny'),
        });
      const ok = await app.otp.over(telefon, 'prihlaseni', String(req.body.kod ?? ''));
      if (!ok) {
        return reply.view('ucty/kod', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          telefon,
          telefonZobrazeny: formatujTelefon(telefon),
          chyba: t('prihlaseni.kod_nespravny'),
        });
      }
      // blokaci prozradíme až majiteli telefonu (po správném kódu), ne komukoliv, kdo číslo zadá
      const existujici = await ucty.podleTelefonu(telefon);
      if (existujici?.blokovan_at) {
        return reply.view('ucty/prihlaseni', {
          titulek: t('prihlaseni.titulek'),
          uid: d.uid,
          chyba: t('prihlaseni.blokovan'),
        });
      }
      const { uzivatel } = await ucty.najdiNeboZaloz(telefon, req.ip);
      return poPrihlaseni(req, reply, d.uid, uzivatel.id, 'sms');
    },
  );

  // alternativa: e-mail + heslo
  app.get<{ Params: { uid: string } }>(`${OIDC_PREFIX}/interaction/:uid/heslo`, async (req, reply) => {
    const d = await detaily(req, reply);
    if (!d || d.uid !== req.params.uid) return chybaInterakce(reply);
    return reply.view('ucty/heslo', { titulek: t('prihlaseni.heslem_titulek'), uid: d.uid });
  });
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
        return reply.view('ucty/heslo', {
          titulek: t('prihlaseni.heslem_titulek'),
          uid: d.uid,
          chyba: t(v.chyba === 'zamceno' ? 'prihlaseni.heslo_zamceno' : 'prihlaseni.heslo_spatne'),
          email: req.body.email,
        });
      }
      return poPrihlaseni(req, reply, d.uid, v.uzivatel.id, 'pwd');
    },
  );

  // GDPR souhlas (po prvním přihlášení)
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
      return dokonci(req, reply, { login: { accountId: ceka.uzivatelId, amr: ['sms'], remember: true } });
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
