// Administrace → Systém → Role: co která role opravňuje (z src/moduly/ucty/role.ts) a kdo ji má.
// Vidí správce obce a administrátor (jen ke čtení); členy přidává a odebírá jen provozovatel.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { ROLE, type Role, type Uzivatel } from '../../db/types.js';
import { maskujTelefon } from '../../lib/kontakty.js';
import { vyzadujRoli } from './opravneni.js';
import { DEFINICE_ROLI, definiceRole, roleSPravem } from './role.js';
import { maRoli, type UctySluzba } from './sluzba.js';
import { CHYBY_ROLI } from './sprava.js';

/** jméno pro přehled; účet bez jména se ukáže maskovaným telefonem (celeJmeno by vrátilo celé číslo) */
const nazevUctu = (u: Pick<Uzivatel, 'jmeno' | 'prijmeni' | 'prezdivka' | 'telefon'>) =>
  `${u.jmeno} ${u.prijmeni}`.trim() || u.prezdivka || maskujTelefon(u.telefon);

const jeRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE as readonly string[]).includes(r);

export default async function spravaRoliRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;

  app.get<{ Querystring: { pridat?: string; q?: string } }>(
    '/sprava/role',
    { preHandler: vyzadujRoli('spravce') },
    async (req, reply) => {
      const jeProvozovatel = maRoli(req.uzivatel, 'provozovatel');
      const clenove = await app.db
        .selectFrom('uzivatele')
        .select(['id', 'jmeno', 'prijmeni', 'prezdivka', 'telefon', 'role', 'blokovan_at'])
        .where(sql<boolean>`cardinality(role) > 0`)
        .orderBy('prijmeni')
        .orderBy('jmeno')
        .orderBy('telefon')
        .execute();
      const pridat = jeProvozovatel && jeRole(req.query.pridat) ? req.query.pridat : null;
      const q = String(req.query.q ?? '')
        .trim()
        .slice(0, 80);
      const nalezene = pridat && q ? await ucty.seznam(q, 20) : [];
      const role = DEFINICE_ROLI.filter((d) => jeRole(d.id)).map((d) => ({
        ...d,
        zahrnujeNazvy: d.zahrnuje.map((r) => definiceRole(r)?.nazev ?? r),
        dediNazvy: roleSPravem(d.id).map((r) => definiceRole(r)?.nazev ?? r),
        clenove: clenove.filter((u) => u.role.includes(d.id)).map((u) => ({ ...u, nazev: nazevUctu(u) })),
      }));
      return reply.view('sprava/role', {
        titulek: t('sprava.role_titulek'),
        role,
        jeProvozovatel,
        pridat,
        q,
        nalezene: nalezene.map((u) => ({ ...u, nazev: nazevUctu(u) })),
      });
    },
  );

  // přidání / odebrání člena role — jen provozovatel (stejná pravidla jako v detailu účtu, zápis do auditu)
  app.post<{ Params: { role: string; akce: string }; Body: { uzivatel?: string } }>(
    '/sprava/role/:role/:akce',
    { preHandler: vyzadujRoli('provozovatel') },
    async (req, reply) => {
      const { role, akce } = req.params;
      if (!jeRole(role) || (akce !== 'pridat' && akce !== 'odebrat')) return reply.callNotFound();
      const zpet = `/sprava/role#role-${role}`;
      const cil = await ucty.podleId(String(req.body?.uzivatel ?? '')).catch(() => undefined);
      if (!cil) return reply.callNotFound();
      const aktor = req.uzivatel!;
      const nazevRole = definiceRole(role)?.nazev ?? role;
      const jmeno = nazevUctu(cil);
      const ma = cil.role.includes(role);
      if ((akce === 'pridat') === ma) {
        req.session.flash = {
          typ: 'info',
          text: t('sprava.role_beze_zmeny', { stav: t(ma ? 'sprava.role_ma' : 'sprava.role_nema') }),
        };
        return reply.redirect(zpet);
      }
      const nove = akce === 'pridat' ? [...cil.role, role] : cil.role.filter((r) => r !== role);
      const chyba = await ucty.kontrolaZmenyRoli(aktor, cil, nove);
      if (chyba) {
        req.session.flash = { typ: 'chyba', text: t(CHYBY_ROLI[chyba]) };
        return reply.redirect(zpet);
      }
      await ucty.nastavRole(cil.id, nove, aktor, req.ip, {
        zdroj: 'stranka-role',
        [akce === 'pridat' ? 'pridano' : 'odebrano']: role,
      });
      req.session.flash = {
        typ: 'ok',
        text: t(akce === 'pridat' ? 'sprava.role_pridano' : 'sprava.role_odebrano', {
          role: nazevRole,
          jmeno,
        }),
      };
      return reply.redirect(zpet);
    },
  );
}
