// Správa účtů úřadem: seznam, detail s rolemi a blokací, audit log, přehled OIDC klientů.
import type { FastifyInstance } from 'fastify';
import { ROLE, type Role, type Uzivatel } from '../../db/types.js';
import { prehledSms } from '../../lib/provoz.js';
import { vyzadujRoli } from './opravneni.js';
import { maRoli, type UctySluzba } from './sluzba.js';

/** smí aktor blokovat/odblokovat cíl? Sám sebe nikdy (odblokovat by se pak nedal), účet admina jen admin. */
export function smiBlokovat(aktor: Uzivatel, cil: Pick<Uzivatel, 'id' | 'role'>): boolean {
  if (aktor.id === cil.id) return false;
  if ((cil.role ?? []).includes('admin') && !maRoli(aktor, 'admin')) return false;
  return true;
}

export default async function spravaRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;
  const urad = vyzadujRoli('spravce', 'ucetni', 'redaktor', 'web', 'deska', 'vstupne');
  const spravce = vyzadujRoli('spravce');

  app.get('/sprava', { preHandler: urad }, async (req, reply) => {
    const u = req.uzivatel!;
    const pocet = await ucty.pocet();
    return reply.view('sprava/index', {
      titulek: t('sprava.titulek'),
      pocet,
      jeSpravce: maRoli(u, 'spravce'),
      // rozpočet SMS a fronta infokanálu — jen správcům (agregáty, bez kontaktů)
      sms: maRoli(u, 'spravce')
        ? await prehledSms(app.db, app.env.SMS_DENNI_LIMIT_KODU, app.obec.moduly.infokanal)
        : null,
      jeRedaktor: maRoli(u, 'redaktor'),
      jeWeb: maRoli(u, 'web'),
      jeDeska: maRoli(u, 'deska'),
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
        role: ROLE,
        historie,
        zamky: await ucty.zamkyUctu(u),
        ted: new Date(),
        jeAdmin: maRoli(req.uzivatel, 'admin'),
        samSobe: req.uzivatel!.id === u.id,
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
        await ucty.odemkni(cil, aktor, req.ip);
        req.session.flash = { typ: 'ok', text: t('sprava.zamek_zrusen') };
      } else if (req.body.akce === 'role') {
        if (!maRoli(aktor, 'admin')) return reply.code(403).send();
        if (cil.id === aktor.id) req.session.flash = { typ: 'chyba', text: t('sprava.sam_sobe') };
        else {
          const r =
            req.body.role === undefined ? [] : Array.isArray(req.body.role) ? req.body.role : [req.body.role];
          await ucty.nastavRole(cil.id, r as Role[], aktor, req.ip);
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
