// Historie změn rolí z audit logu. Každá změna rolí (stránka Role, detail účtu, vypršení dočasné role) se píše jako
// akce `sprava.role` s detailem { cil, role, puvodne, pridano, odebrano, platnost?, zdroj? }. Starší záznamy
// (před 26. 10. 2026) pole pridano/odebrano nemají nebo mají jen jednu roli — rozdíl se proto dopočítá z role/puvodne.
// Poslední aktivita členů rolí: poslední přihlášení (audit `prihlaseni`) a poslední aktivita sezení.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { ROLE, type Role, type Uzivatel } from '../../db/types.js';
import { maskujTelefon } from '../../lib/kontakty.js';

const jeRole = (r: unknown): r is Role => typeof r === 'string' && (ROLE as readonly string[]).includes(r);
const pole = (v: unknown): Role[] => (Array.isArray(v) ? v.filter(jeRole) : jeRole(v) ? [v] : []);

/** jméno pro přehledy; účet bez jména maskovaným telefonem */
export const nazevUctu = (u: Pick<Uzivatel, 'jmeno' | 'prijmeni' | 'prezdivka' | 'telefon'>) =>
  `${u.jmeno} ${u.prijmeni}`.trim() || u.prezdivka || maskujTelefon(u.telefon);

export interface ZmenaRoli {
  id: number;
  ts: Date;
  /** null = systém (vypršení dočasné role) */
  aktor: { id: string; nazev: string } | null;
  cil: { id: string; nazev: string } | null;
  pridano: Role[];
  odebrano: Role[];
  /** role → ISO konce platnosti, nebo null = nově trvale */
  platnost: Record<string, string | null>;
  zdroj: string | null;
}

/** rozdíl rolí z detailu záznamu (nový formát má pridano/odebrano, starý jen role + puvodne) */
export function rozdilZDetailu(d: Record<string, unknown>): { pridano: Role[]; odebrano: Role[] } {
  const role = pole(d.role);
  const puvodne = pole(d.puvodne);
  if (Array.isArray(d.role) && Array.isArray(d.puvodne))
    return {
      pridano: role.filter((r) => !puvodne.includes(r)),
      odebrano: puvodne.filter((r) => !role.includes(r)),
    };
  return { pridano: pole(d.pridano), odebrano: pole(d.odebrano) };
}

export async function historieRoli(
  db: Db,
  volby: { uzivatelId?: string; limit: number; offset?: number },
): Promise<{ zaznamy: ZmenaRoli[]; celkem: number }> {
  let q = db.selectFrom('audit_log').where('akce', '=', 'sprava.role');
  if (volby.uzivatelId) q = q.where((eb) => eb(eb.ref('detail', '->>').key('cil'), '=', volby.uzivatelId!));
  const celkem = Number(
    (await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n,
  );
  const radky = await q
    .select(['id', 'ts', 'uzivatel_id', 'detail'])
    .orderBy('ts', 'desc')
    .orderBy('id', 'desc')
    .limit(volby.limit)
    .offset(volby.offset ?? 0)
    .execute();
  const idUctu = new Set<string>();
  for (const r of radky) {
    if (r.uzivatel_id) idUctu.add(r.uzivatel_id);
    const cil = (r.detail as Record<string, unknown> | null)?.cil;
    if (typeof cil === 'string') idUctu.add(cil);
  }
  const ucty = idUctu.size
    ? await db
        .selectFrom('uzivatele')
        .select(['id', 'jmeno', 'prijmeni', 'prezdivka', 'telefon'])
        .where('id', 'in', [...idUctu])
        .execute()
    : [];
  const nazvy = new Map(ucty.map((u) => [u.id, nazevUctu(u)]));
  const ucet = (id: unknown) =>
    typeof id === 'string' ? { id, nazev: nazvy.get(id) ?? '(smazaný účet)' } : null;
  return {
    celkem,
    zaznamy: radky.map((r) => {
      const d = (r.detail ?? {}) as Record<string, unknown>;
      const p =
        d.platnost && typeof d.platnost === 'object' ? (d.platnost as Record<string, string | null>) : {};
      return {
        id: r.id,
        ts: r.ts,
        aktor: ucet(r.uzivatel_id),
        cil: ucet(d.cil),
        ...rozdilZDetailu(d),
        platnost: p,
        zdroj: typeof d.zdroj === 'string' ? d.zdroj : null,
      };
    }),
  };
}

/** role, u nichž se hlídá „spící“ účet (silná práva bez nedávného přihlášení) */
export const HLIDANE_ROLE: readonly Role[] = ['provozovatel', 'admin', 'spravce'];
export const SPICI_DNI = 90;

export interface AktivitaUctu {
  prihlaseni: Date | null;
  aktivita: Date | null;
}

/** poslední přihlášení a poslední aktivita sezení pro dané účty */
export async function aktivitaUctu(db: Db, ids: string[]): Promise<Map<string, AktivitaUctu>> {
  const m = new Map<string, AktivitaUctu>();
  if (!ids.length) return m;
  const r = await sql<{ id: string; prihlaseni: Date | null; aktivita: Date | null }>`
    SELECT u.id,
           (SELECT max(a.ts) FROM audit_log a WHERE a.uzivatel_id = u.id AND a.akce = 'prihlaseni') AS prihlaseni,
           (SELECT max(coalesce(s.aktivita_at, s.vytvoreno_at)) FROM sezeni s
             WHERE s.data->>'uzivatelId' = u.id::text) AS aktivita
      FROM uzivatele u
     WHERE u.id = ANY(${sql.val(ids)}::uuid[])`.execute(db);
  for (const x of r.rows) m.set(x.id, { prihlaseni: x.prihlaseni, aktivita: x.aktivita });
  return m;
}

/**
 * Spící účet: má silnou roli a nepřihlásil se (ani nebyl aktivní) déle než SPICI_DNI dní. Účet, který se zatím
 * nepřihlásil vůbec, spí až SPICI_DNI dní od založení (převedené účty nemají starší přihlášení v evidenci).
 */
export function jeSpici(
  u: Pick<Uzivatel, 'role' | 'vytvoren_at' | 'blokovan_at'>,
  a: AktivitaUctu | undefined,
  ted = new Date(),
): boolean {
  if (u.blokovan_at || !u.role.some((r) => HLIDANE_ROLE.includes(r))) return false;
  const casy = [a?.prihlaseni, a?.aktivita].filter((x): x is Date => !!x).map((x) => x.getTime());
  const posledni = casy.length ? Math.max(...casy) : u.vytvoren_at.getTime();
  return ted.getTime() - posledni > SPICI_DNI * 86_400_000;
}
