// Videa obecního webu: vlastní soubor (MP4/WebM s plakátem a titulky) nebo odkaz na YouTube/Vimeo s lokálně
// uloženým náhledem (přehrávač cizí služby se načte až po kliknutí návštěvníka). Pořadí, „na titulce“,
// koncept/zveřejněno a koš jako u ostatního obsahu webu.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE web_videa (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nazev text NOT NULL,
      popis text NOT NULL DEFAULT '',
      prepis text NOT NULL DEFAULT '',             -- textový popis / přepis videa (přístupnost)
      zdroj text NOT NULL,                         -- soubor | youtube | vimeo
      externi_id text NOT NULL DEFAULT '',         -- id videa na YouTube / Vimeu (Vimeo neveřejné: id:hash)
      soubor_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      plakat_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      titulky_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      poradi integer NOT NULL DEFAULT 100,
      na_titulce boolean NOT NULL DEFAULT false,
      stav text NOT NULL DEFAULT 'koncept',        -- koncept | zverejneno
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      puvodni_url text,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz
    );
    CREATE INDEX web_videa_poradi_idx ON web_videa (poradi, vytvoreno_at) WHERE smazano_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS web_videa`.execute(db);
}
