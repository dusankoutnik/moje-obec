// Dočasné role (tabulka role_platnost, migrace 0025): role v uzivatele.role, která platí jen do daného okamžiku.
// Vypršenou roli odebírá plánovač (ucty/index.ts, každou minutu) a navíc kontrola při načtení účtu (app.ts —
// přihlášený uživatel, OIDC claims, interní API), takže v mezidobí mezi vypršením a během plánovače se nepoužije.
// Odebrání se zapíše do auditu jako běžná změna rolí (akce sprava.role, zdroj „vyprseni“, aktor = systém).
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Role } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { datumPraha, konecDne } from '../../lib/datum.js';

/** role, které dočasné být nemohou: provozovatel (vypršení by mohlo nechat instalaci bez provozovatele) */
export const ROLE_JEN_TRVALE: readonly Role[] = ['provozovatel'];

/**
 * Datum z formuláře (RRRR-MM-DD) → okamžik konce platnosti (konec dne v Praze, den se počítá celý).
 * Prázdné = trvale (null); nesmyslné nebo dnešní/minulé datum = 'neplatne'.
 */
export function platiDoZDatumu(datum: unknown, ted = new Date()): Date | null | 'neplatne' {
  const s = String(datum ?? '').trim();
  if (!s) return null;
  const d = konecDne(s);
  if (!d || datumPraha(d) !== s) return 'neplatne';
  if (s <= datumPraha(ted)) return 'neplatne';
  return d;
}

/** platnosti rolí jednoho účtu (role → do kdy) */
export async function platnostiUctu(db: Db, uzivatelId: string): Promise<Map<Role, Date>> {
  const r = await db
    .selectFrom('role_platnost')
    .select(['role', 'plati_do'])
    .where('uzivatel_id', '=', uzivatelId)
    .execute();
  return new Map(r.map((x) => [x.role, x.plati_do]));
}

/** platnosti všech dočasných rolí (účet → role → do kdy) — pro stránku Role */
export async function platnostiVsech(db: Db): Promise<Map<string, Map<Role, Date>>> {
  const r = await db.selectFrom('role_platnost').select(['uzivatel_id', 'role', 'plati_do']).execute();
  const m = new Map<string, Map<Role, Date>>();
  for (const x of r) {
    if (!m.has(x.uzivatel_id)) m.set(x.uzivatel_id, new Map());
    m.get(x.uzivatel_id)!.set(x.role, x.plati_do);
  }
  return m;
}

/**
 * Odebere vypršené dočasné role (všem, nebo jen jednomu účtu). Vrací účet → jeho role po odebrání.
 * Bezpečné souběžně: řádek účtu se zamyká a mazání bere jen opravdu vypršené záznamy.
 */
export async function vyprsRole(
  db: Db,
  volby: { uzivatelId?: string; ted?: Date } = {},
): Promise<Map<string, Role[]>> {
  const ted = volby.ted ?? new Date();
  let q = db.selectFrom('role_platnost').select(['uzivatel_id', 'role']).where('plati_do', '<=', ted);
  if (volby.uzivatelId) q = q.where('uzivatel_id', '=', volby.uzivatelId);
  const vyprsele = await q.execute();
  const vysledek = new Map<string, Role[]>();
  if (!vyprsele.length) return vysledek;
  const podleUctu = new Map<string, Role[]>();
  for (const v of vyprsele) podleUctu.set(v.uzivatel_id, [...(podleUctu.get(v.uzivatel_id) ?? []), v.role]);
  for (const [uid, role] of podleUctu) {
    await db.transaction().execute(async (tx) => {
      const u = await tx
        .selectFrom('uzivatele')
        .select('role')
        .where('id', '=', uid)
        .forUpdate()
        .executeTakeFirst();
      const smazane = await tx
        .deleteFrom('role_platnost')
        .where('uzivatel_id', '=', uid)
        .where('role', 'in', role)
        .where('plati_do', '<=', ted)
        .returning('role')
        .execute();
      if (!u || !smazane.length) return;
      const pryc = new Set(smazane.map((s) => s.role));
      const nove = u.role.filter((r) => !pryc.has(r));
      vysledek.set(uid, nove);
      if (nove.length === u.role.length) return;
      await tx
        .updateTable('uzivatele')
        .set({ role: nove, upraven_at: new Date() })
        .where('id', '=', uid)
        .execute();
      await zapisAudit(tx, {
        uzivatelId: null,
        akce: 'sprava.role',
        detail: {
          cil: uid,
          role: nove,
          puvodne: u.role,
          pridano: [],
          odebrano: u.role.filter((r) => pryc.has(r)),
          zdroj: 'vyprseni',
        },
      });
    });
  }
  return vysledek;
}

/** pro načtený účet: odebere jeho vypršené role a vrátí platné (občan bez rolí = žádný dotaz navíc) */
export async function platneRole(db: Db, u: { id: string; role: Role[] }): Promise<Role[]> {
  if (!u.role.length) return u.role;
  const r = await vyprsRole(db, { uzivatelId: u.id });
  return r.get(u.id) ?? u.role;
}

/** počet účtů s dočasnou rolí (stav systému) */
export async function pocetDocasnych(db: Db): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(DISTINCT uzivatel_id)::int AS n FROM role_platnost`.execute(
    db,
  );
  return r.rows[0]?.n ?? 0;
}
