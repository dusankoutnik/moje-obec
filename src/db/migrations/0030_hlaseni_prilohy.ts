// Přílohy hlášení infokanálu (jako ve VlastiKanálu): soubory z úložiště obce, které jdou e-mailem (příloha nebo
// odkaz podle velikosti) a zveřejní se pod článkem z hlášení. Ukládá se snímek [{id, nazev, velikost, mime}],
// soubory samy zůstávají v tabulce soubory.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ik_hlaseni ADD COLUMN prilohy jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE ik_hlaseni DROP COLUMN IF EXISTS prilohy`.execute(db);
}
