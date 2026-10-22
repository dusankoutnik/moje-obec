// API pro integrace (docs/MODULY.md → API): tokeny s rozsahy oprávnění, idempotence obsahu přes zdroj + externi_id
// a čísla obecního zpravodaje se strukturovanými údaji (docs/ZPRAVODAJ-API.md).
// api_tokeny: token se ukládá jen jako SHA-256 (hex); prefix = prvních pár znaků pro poznání ve správě.
// web_obsah.externi_id: identifikátor záznamu v systému klienta; unikátní se zdrojem mezi nesmazanými.
// web_zpravodaj: jedno číslo (ročník + číslo) ↔ příspěvek; obyvatel z evidence → počet obyvatel v úvodu webu.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE api_tokeny (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nazev text NOT NULL,
      hash text NOT NULL UNIQUE,
      prefix text NOT NULL,
      rozsahy text[] NOT NULL DEFAULT '{}',
      zalozil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vytvoren_at timestamptz NOT NULL DEFAULT now(),
      posledni_pouziti_at timestamptz,
      posledni_ip text,
      pouziti integer NOT NULL DEFAULT 0,
      zruseno_at timestamptz,
      zrusil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL
    );
    ALTER TABLE web_obsah ADD COLUMN externi_id text;
    CREATE UNIQUE INDEX web_obsah_externi_idx ON web_obsah (zdroj, externi_id)
      WHERE externi_id IS NOT NULL AND smazano_at IS NULL;
    CREATE TABLE web_zpravodaj (
      id serial PRIMARY KEY,
      rocnik integer NOT NULL,
      cislo integer NOT NULL,
      obsah_id uuid REFERENCES web_obsah(id) ON DELETE SET NULL,
      vydano text NOT NULL CHECK (vydano ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),   -- YYYY-MM-DD (řadí se jako text)
      obyvatel integer,
      evidence_k text,
      metadata jsonb NOT NULL,
      pdf_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      pdf_tisk_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      obalka_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (rocnik, cislo)
    );
    CREATE INDEX web_zpravodaj_vydano_idx ON web_zpravodaj (vydano DESC) WHERE obyvatel IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS web_zpravodaj;
    DROP INDEX IF EXISTS web_obsah_externi_idx;
    ALTER TABLE web_obsah DROP COLUMN IF EXISTS externi_id;
    DROP TABLE IF EXISTS api_tokeny;
  `.execute(db);
}
