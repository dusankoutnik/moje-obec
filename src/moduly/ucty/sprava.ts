// Správa účtů úřadem: seznam, detail s rolemi a blokací, audit log, přehled OIDC klientů.
import type { FastifyInstance } from 'fastify';
import { ROLE, type Role, type Uzivatel } from '../../db/types.js';
import { prehledSms } from '../../lib/provoz.js';
import { vyzadujRoli } from './opravneni.js';
import { DEFINICE_ROLI } from './role.js';
import { jeChraneny, maRoli, smiUpravitUcet, type UctySluzba } from './sluzba.js';

/**
 * Smí aktor blokovat/odblokovat cíl? Sám sebe nikdy (odblokovat by se pak nedal), účet admina jen admin,
 * chráněný účet (provozovatel) jen provozovatel.
 */
export function smiBlokovat(aktor: Uzivatel, cil: Pick<Uzivatel, 'id' | 'role'>): boolean {
  if (aktor.id === cil.id) return false;
  if ((cil.role ?? []).includes('admin') && !maRoli(aktor, 'admin')) return false;
  return smiUpravitUcet(aktor, cil);
}

/** klíč chyby z UctySluzba.kontrolaZmenyRoli → text pro flash */
export const CHYBY_ROLI = {
  nema_pravo: 'sprava.role_nema_pravo',
  sam_sobe: 'sprava.sam_sobe',
  jen_provozovatel: 'sprava.role_jen_provozovatel',
  chraneny: 'sprava.chraneny_nelze',
  posledni_provozovatel: 'sprava.role_posledni_provozovatel',
} as const;

export default async function spravaRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;
  const urad = vyzadujRoli('spravce', 'ucetni', 'redaktor', 'web', 'deska', 'kviz', 'vstupne');
  const spravce = vyzadujRoli('spravce');

  app.get('/sprava', { preHandler: urad }, async (req, reply) => {
    const u = req.uzivatel!;
    const pocet = await ucty.pocet();
    return reply.view('sprava/index', {
      titulek: t('sprava.titulek'),
      pocet,
      jeSpravce: maRoli(u, 'spravce'),
      jeAdmin: maRoli(u, 'admin'),
      // vzhled webu a správa rolí — jen provozovatel
      jeProvozovatel: maRoli(u, 'provozovatel'),
      // rozpočet SMS a fronta infokanálu — jen správcům (agregáty, bez kontaktů)
      sms: maRoli(u, 'spravce')
        ? await prehledSms(app.db, app.env.SMS_DENNI_LIMIT_KODU, app.obec.moduly.infokanal)
        : null,
      jeRedaktor: maRoli(u, 'redaktor'),
      jeWeb: maRoli(u, 'web'),
      // termíny z rezervací, které čekají na redaktora webu (koncepty, návrhy propojení, změny)
      akceKeZpracovani:
        app.obec.moduly.web && maRoli(u, 'web') ? await app.web.propojeni.pocet().catch(() => 0) : 0,
      jeDeska: maRoli(u, 'deska'),
      // fronta textu dokumentů (OCR) — kdo nahrává dokumenty (web, deska)
      textDokumentu:
        app.obec.moduly.web && maRoli(u, 'web', 'deska')
          ? await app.textSouboru.prehled().catch(() => null)
          : null,
      jeKviz: maRoli(u, 'kviz', 'web'),
      // podání obsahují osobní údaje — jen správce obce (admin má vše)
      podatelnaNevyrizene:
        app.obec.moduly.podatelna && maRoli(u, 'spravce') ? await app.podatelna.pocetNevyrizenych() : null,
      // dlaždice aplikací (rezervace…) a úřední agenda účtů — modul administrace
      aplikace: app.hasDecorator('administrace')
        ? await app.administrace.dlazdice(u).catch(() => null)
        : null,
    });
  });

  app.get<{ Querystring: { q?: string } }>(
    '/sprava/uzivatele',
    { preHandler: spravce },
    async (req, reply) => {
      const seznam = await ucty.seznam(req.query.q ?? '');
      const pocet = await ucty.pocet();
      return reply.view('sprava/uzivatele', {
        titulek: t('sprava.uzivatele'),
        seznam,
        pocet,
        q: req.query.q ?? '',
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/uzivatele/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const u = await ucty.podleId(req.params.id).catch(() => undefined);
      if (!u) return reply.callNotFound();
      const historie = await app.db
        .selectFrom('audit_log')
        .selectAll()
        .where((eb) =>
          eb.or([eb('uzivatel_id', '=', u.id), eb(eb.ref('detail', '->>').key('cil'), '=', u.id)]),
        )
        .orderBy('ts', 'desc')
        .limit(50)
        .execute();
      return reply.view('sprava/uzivatel', {
        titulek: t('sprava.detail'),
        u,
        role: DEFINICE_ROLI.filter((d) => (ROLE as readonly string[]).includes(d.id)),
        historie,
        zamky: await ucty.zamkyUctu(u),
        ted: new Date(),
        jeAdmin: maRoli(req.uzivatel, 'admin'),
        jeProvozovatel: maRoli(req.uzivatel, 'provozovatel'),
        samSobe: req.uzivatel!.id === u.id,
        chraneny: jeChraneny(u),
        smiUpravit: smiUpravitUcet(req.uzivatel, u),
        // formulář rolí: admin u cizího nechráněného účtu, provozovatel všude (i u sebe)
        smiMenitRole:
          maRoli(req.uzivatel, 'provozovatel') ||
          (maRoli(req.uzivatel, 'admin') && req.uzivatel!.id !== u.id && !jeChraneny(u)),
        smiBlokovat: smiBlokovat(req.uzivatel!, u),
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { role?: string | string[]; akce?: string } }>(
    '/sprava/uzivatele/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const cil = await ucty.podleId(req.params.id).catch(() => undefined);
      if (!cil) return reply.callNotFound();
      const aktor = req.uzivatel!;
      if (req.body.akce === 'blokovat' || req.body.akce === 'odblokovat') {
        if (!smiBlokovat(aktor, cil)) {
          req.session.flash = { typ: 'chyba', text: t('sprava.blokace_nelze') };
          return reply.redirect(`/sprava/uzivatele/${cil.id}`);
        }
        await ucty.blokuj(cil.id, req.body.akce === 'blokovat', aktor, req.ip);
        req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      } else if (req.body.akce === 'odemknout') {
        if (!smiUpravitUcet(aktor, cil)) {
          req.session.flash = { typ: 'chyba', text: t('sprava.chraneny_nelze') };
          return reply.redirect(`/sprava/uzivatele/${cil.id}`);
        }
        await ucty.odemkni(cil, aktor, req.ip);
        req.session.flash = { typ: 'ok', text: t('sprava.zamek_zrusen') };
      } else if (req.body.akce === 'role') {
        if (!maRoli(aktor, 'admin')) return reply.code(403).send();
        const r = (
          req.body.role === undefined ? [] : Array.isArray(req.body.role) ? req.body.role : [req.body.role]
        ).filter((x): x is Role => (ROLE as readonly string[]).includes(x));
        const chyba = await ucty.kontrolaZmenyRoli(aktor, cil, r);
        if (chyba) req.session.flash = { typ: 'chyba', text: t(CHYBY_ROLI[chyba]) };
        else {
          await ucty.nastavRole(cil.id, r, aktor, req.ip, { zdroj: 'detail-uctu' });
          req.session.flash = { typ: 'ok', text: t('sprava.role_ulozeny') };
        }
      }
      return reply.redirect(`/sprava/uzivatele/${cil.id}`);
    },
  );

  app.get('/sprava/audit', { preHandler: spravce }, async (_req, reply) => {
    const zaznamy = await app.db
      .selectFrom('audit_log')
      .leftJoin('uzivatele', 'uzivatele.id', 'audit_log.uzivatel_id')
      .select([
        'audit_log.id',
        'audit_log.ts',
        'audit_log.akce',
        'audit_log.detail',
        'audit_log.ip',
        'audit_log.uzivatel_id',
        'uzivatele.jmeno',
        'uzivatele.prijmeni',
        'uzivatele.telefon',
      ])
      .orderBy('audit_log.ts', 'desc')
      .limit(200)
      .execute();
    return reply.view('sprava/audit', { titulek: t('sprava.audit'), zaznamy });
  });

  app.get('/sprava/klienti', { preHandler: vyzadujRoli('admin') }, async (_req, reply) => {
    const klienti = await app.db
      .selectFrom('oidc_klienti')
      .select(['client_id', 'nazev', 'redirect_uris', 'duveryhodny', 'aktivni', 'vytvoren_at'])
      .orderBy('vytvoren_at')
      .execute();
    return reply.view('sprava/klienti', {
      titulek: t('sprava.klienti'),
      klienti,
      issuer: `${app.env.BASE_URL}/oidc`,
    });
  });
}
