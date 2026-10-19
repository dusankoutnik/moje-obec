// Zámek přihlášení heslem po opakovaných chybách (doplněk k limitům podle IP, které obejde botnet nebo IPv6).
// Klíč je e-mail (přihlášení) nebo id účtu (ověření heslem před citlivou změnou). Neexistující e-mail se
// zamyká úplně stejně jako existující — odpověď tak neprozradí, jestli účet existuje.
// Přihlášení SMS kódem zámek neblokuje: oběť útoku se dostane dovnitř a heslo si změní.
import { sql } from 'kysely';
import type { Db } from '../db/index.js';

/** po kolika chybách za sebou se zamyká */
export const ZAMEK_PO_CHYBACH = 5;
/** první zámek; každá další chyba po vypršení zámek zdvojnásobí */
export const ZAMEK_ZAKLAD_MIN = 15;
/** nejdelší zámek */
export const ZAMEK_MAX_MIN = 24 * 60;
/** po jak dlouhém klidu se čítač chyb zapomene */
export const ZAMEK_ZAPOMENOUT_H = 24;

export const klicEmail = (email: string) => `email:${email.trim().toLowerCase()}`;
export const klicUcet = (id: string) => `ucet:${id}`;

/** délka zámku v minutách pro daný počet chyb (0 = nezamykat) */
export function delkaZamkuMin(chyby: number): number {
  if (chyby < ZAMEK_PO_CHYBACH) return 0;
  const nasobek = 2 ** Math.min(chyby - ZAMEK_PO_CHYBACH, 16);
  return Math.min(ZAMEK_ZAKLAD_MIN * nasobek, ZAMEK_MAX_MIN);
}

export interface StavZamku {
  klic: string;
  chyby: number;
  zamcenoDo: Date | null;
}

/** je klíč právě zamčený? vrací konec zámku, nebo null */
export async function zamcenoDo(db: Db, klic: string, ted = new Date()): Promise<Date | null> {
  const r = await db
    .selectFrom('prihlaseni_zamky')
    .select('zamceno_do')
    .where('klic', '=', klic)
    .executeTakeFirst();
  return r?.zamceno_do && r.zamceno_do > ted ? r.zamceno_do : null;
}

/** zapíše neúspěšný pokus; vrátí stav po zápisu (zamcenoDo != null = právě se zamklo) */
export async function zapisChybu(db: Db, klic: string): Promise<StavZamku> {
  // čítač se po dlouhém klidu nuluje; atomicky přes ON CONFLICT (souběžné pokusy se nesčítají špatně)
  const r = await db
    .insertInto('prihlaseni_zamky')
    .values({ klic, chyby: 1 })
    .onConflict((oc) =>
      oc.column('klic').doUpdateSet({
        chyby: sql<number>`CASE WHEN prihlaseni_zamky.posledni_chyba_at < now() - make_interval(hours => ${ZAMEK_ZAPOMENOUT_H}) THEN 1 ELSE prihlaseni_zamky.chyby + 1 END`,
        posledni_chyba_at: sql<Date>`now()`,
      }),
    )
    .returning(['chyby'])
    .executeTakeFirstOrThrow();
  const min = delkaZamkuMin(r.chyby);
  if (!min) return { klic, chyby: r.chyby, zamcenoDo: null };
  const z = await db
    .updateTable('prihlaseni_zamky')
    .set({ zamceno_do: sql<Date>`now() + make_interval(mins => ${min})` })
    .where('klic', '=', klic)
    .returning('zamceno_do')
    .executeTakeFirstOrThrow();
  return { klic, chyby: r.chyby, zamcenoDo: z.zamceno_do };
}

/** po úspěšném přihlášení (nebo odemčení správcem) se čítač maže */
export async function zrusZamek(db: Db, ...klice: string[]): Promise<number> {
  if (!klice.length) return 0;
  const r = await db.deleteFrom('prihlaseni_zamky').where('klic', 'in', klice).executeTakeFirst();
  return Number(r.numDeletedRows ?? 0);
}

/** stav čítačů pro detail účtu ve správě (jen klíče, které existují) */
export async function stavZamku(db: Db, klice: string[]): Promise<StavZamku[]> {
  if (!klice.length) return [];
  const radky = await db.selectFrom('prihlaseni_zamky').selectAll().where('klic', 'in', klice).execute();
  return radky.map((r) => ({ klic: r.klic, chyby: r.chyby, zamcenoDo: r.zamceno_do }));
}

/** úklid: čítače, které už nic nezamykají a čítač by se stejně zapomněl */
export async function uklidZamku(db: Db): Promise<void> {
  await db
    .deleteFrom('prihlaseni_zamky')
    .where('posledni_chyba_at', '<', sql<Date>`now() - make_interval(hours => ${ZAMEK_ZAPOMENOUT_H})`)
    .where((eb) => eb.or([eb('zamceno_do', 'is', null), eb('zamceno_do', '<', sql<Date>`now()`)]))
    .execute();
}
