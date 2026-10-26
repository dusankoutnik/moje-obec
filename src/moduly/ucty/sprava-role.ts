// Administrace → Systém → Role: co která role opravňuje (z src/moduly/ucty/role.ts), matice oprávnění, kdo roli
// má (s poslední aktivitou, spícími účty a dočasnou platností) a historie změn rolí.
// Vidí správce obce a administrátor (jen ke čtení); členy přidává a odebírá jen provozovatel.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { ROLE, type Role } from '../../db/types.js';
import { vyzadujRoli } from './opravneni.js';
import { aktivitaUctu, historieRoli, jeSpici, nazevUctu, SPICI_DNI } from './role-historie.js';
import { platiDoZDatumu, platnostiVsech, ROLE_JEN_TRVALE, vyprsRole } from './role-platnost.js';
import { DEFINICE_ROLI, definiceRole, OBLASTI_SPRAVY, roleSmiOblast, roleSPravem } from './role.js';
import { maRoli, type UctySluzba } from './sluzba.js';
import { CHYBY_ROLI } from './sprava.js';

const jeRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE as readonly string[]).includes(r);
const NA_STRANKU = 50;

export default async function spravaRoliRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const t = app.t;
  const nazevRole = (r: string) => (jeRole(r) ? (definiceRole(r)?.nazev ?? r) : r);
  const ZDROJE: Record<string, string> = {
    'stranka-role': 'sprava.role_zdroj_stranka_role',
    'detail-uctu': 'sprava.role_zdroj_detail_uctu',
    vyprseni: 'sprava.role_zdroj_vyprseni',
  };
  const zdrojZmeny = (z: string) => (ZDROJE[z] ? t(ZDROJE[z]) : z);

  app.get<{ Querystring: { pridat?: string; q?: string } }>(
    '/sprava/role',
    { preHandler: vyzadujRoli('spravce') },
    async (req, reply) => {
      const jeProvozovatel = maRoli(req.uzivatel, 'provozovatel');
      await vyprsRole(app.db);
      const clenove = await app.db
        .selectFrom('uzivatele')
        .select(['id', 'jmeno', 'prijmeni', 'prezdivka', 'telefon', 'role', 'blokovan_at', 'vytvoren_at'])
        .where(sql<boolean>`cardinality(role) > 0`)
        .orderBy('prijmeni')
        .orderBy('jmeno')
        .orderBy('telefon')
        .execute();
      const platnosti = await platnostiVsech(app.db);
      const aktivita = await aktivitaUctu(
        app.db,
        clenove.map((u) => u.id),
      );
      const pridat = jeProvozovatel && jeRole(req.query.pridat) ? req.query.pridat : null;
      const q = String(req.query.q ?? '')
        .trim()
        .slice(0, 80);
      const nalezene = pridat && q ? await ucty.seznam(q, 20) : [];
      const ted = new Date();
      const sAktivitou = clenove.map((u) => {
        const a = aktivita.get(u.id);
        return {
          ...u,
          nazev: nazevUctu(u),
          prihlaseni: a?.prihlaseni ?? null,
          aktivita: a?.aktivita ?? null,
          spici: jeSpici(u, a, ted),
        };
      });
      const role = DEFINICE_ROLI.filter((d) => jeRole(d.id)).map((d) => ({
        ...d,
        zahrnujeNazvy: d.zahrnuje.map((r) => definiceRole(r)?.nazev ?? r),
        dediNazvy: roleSPravem(d.id).map((r) => definiceRole(r)?.nazev ?? r),
        jenTrvale: ROLE_JEN_TRVALE.includes(d.id),
        clenove: sAktivitou
          .filter((u) => u.role.includes(d.id))
          .map((u) => ({ ...u, platiDo: platnosti.get(u.id)?.get(d.id) ?? null })),
      }));
      const moduly = app.obec.moduly as unknown as Record<string, boolean>;
      const matice = OBLASTI_SPRAVY.filter((o) => !o.modul || moduly[o.modul]).map((o) => ({
        nazev: o.nazev,
        role: DEFINICE_ROLI.map((d) => roleSmiOblast(d.id, o)),
      }));
      return reply.view('sprava/role', {
        titulek: t('sprava.role_titulek'),
        role,
        matice,
        jeProvozovatel,
        jeAdmin: maRoli(req.uzivatel, 'admin'),
        spiciDni: SPICI_DNI,
        spicich: sAktivitou.filter((u) => u.spici).length,
        historie: (await historieRoli(app.db, { limit: 10 })).zaznamy,
        nazevRole,
        zdrojZmeny,
        pridat,
        q,
        dnes: ted,
        nalezene: nalezene.map((u) => ({ ...u, nazev: nazevUctu(u) })),
      });
    },
  );

  // Historie změn rolí: kdo komu kdy jakou roli přidal nebo odebral (z audit logu), filtr podle účtu, stránkování.
  app.get<{ Querystring: { uzivatel?: string; strana?: string } }>(
    '/sprava/role/historie',
    { preHandler: vyzadujRoli('spravce') },
    async (req, reply) => {
      const uid = String(req.query.uzivatel ?? '');
      const ucet = /^[0-9a-f-]{36}$/i.test(uid) ? await ucty.podleId(uid).catch(() => undefined) : undefined;
      const strana = Math.max(1, Math.min(10_000, Number.parseInt(String(req.query.strana ?? '1'), 10) || 1));
      const { zaznamy, celkem } = await historieRoli(app.db, {
        uzivatelId: ucet?.id,
        limit: NA_STRANKU,
        offset: (strana - 1) * NA_STRANKU,
      });
      const stran = Math.max(1, Math.ceil(celkem / NA_STRANKU));
      const odkaz = (s: number) =>
        `/sprava/role/historie?${new URLSearchParams({ ...(ucet ? { uzivatel: ucet.id } : {}), strana: String(s) })}`;
      return reply.view('sprava/role-historie', {
        titulek: t('sprava.role_historie'),
        zaznamy,
        celkem,
        ucet: ucet ? { id: ucet.id, nazev: nazevUctu(ucet) } : null,
        strana,
        stran,
        predchozi: strana > 1 ? odkaz(strana - 1) : null,
        dalsi: strana < stran ? odkaz(strana + 1) : null,
        nazevRole,
        zdrojZmeny,
      });
    },
  );

  // přidání / odebrání člena role — jen provozovatel (stejná pravidla jako v detailu účtu, zápis do auditu)
  app.post<{ Params: { role: string; akce: string }; Body: { uzivatel?: string; plati_do?: string } }>(
    '/sprava/role/:role/:akce',
    { preHandler: vyzadujRoli('provozovatel') },
    async (req, reply) => {
      const { role, akce } = req.params;
      if (!jeRole(role) || (akce !== 'pridat' && akce !== 'odebrat')) return reply.callNotFound();
      const zpet = `/sprava/role#role-${role}`;
      const cil = await ucty.podleId(String(req.body?.uzivatel ?? '')).catch(() => undefined);
      if (!cil) return reply.callNotFound();
      const aktor = req.uzivatel!;
      const jmeno = nazevUctu(cil);
      const platiDo = akce === 'pridat' ? platiDoZDatumu(req.body?.plati_do) : null;
      if (platiDo === 'neplatne') {
        req.session.flash = { typ: 'chyba', text: t('sprava.role_platnost_neplatna') };
        return reply.redirect(zpet);
      }
      if (platiDo && ROLE_JEN_TRVALE.includes(role)) {
        req.session.flash = { typ: 'chyba', text: t('sprava.role_jen_trvale', { role: nazevRole(role) }) };
        return reply.redirect(zpet);
      }
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
      await ucty.nastavRole(
        cil.id,
        nove,
        aktor,
        req.ip,
        { zdroj: 'stranka-role' },
        new Map(platiDo ? [[role, platiDo]] : []),
      );
      req.session.flash = {
        typ: 'ok',
        text: t(akce === 'pridat' ? 'sprava.role_pridano' : 'sprava.role_odebrano', {
          role: nazevRole(role),
          jmeno,
        }),
      };
      return reply.redirect(zpet);
    },
  );
}
