// Rubriky aktualit: vnořené (nadřazená rubrika) a příspěvek ve více rubrikách. Hlavní rubrika zůstává v
// web_obsah.kategorie_id (štítek na kartě, odkaz u článku), další jsou v kategorie_dalsi. Filtr rubriky na webu
// bere hlavní i další rubriky a všechny podrubriky.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE web_kategorie ADD COLUMN nadrazena_id integer REFERENCES web_kategorie(id) ON DELETE SET NULL;
    ALTER TABLE web_obsah ADD COLUMN kategorie_dalsi integer[] NOT NULL DEFAULT '{}';
    CREATE INDEX web_obsah_kategorie_dalsi_idx ON web_obsah USING gin (kategorie_dalsi);
    CREATE INDEX web_obsah_kategorie_idx ON web_obsah (kategorie_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS web_obsah_kategorie_idx;
    ALTER TABLE web_obsah DROP COLUMN IF EXISTS kategorie_dalsi;
    ALTER TABLE web_kategorie DROP COLUMN IF EXISTS nadrazena_id;
  `.execute(db);
}
