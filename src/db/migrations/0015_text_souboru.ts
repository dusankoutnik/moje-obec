// Text nahraných dokumentů (textová vrstva PDF, OCR skenů, kancelářské formáty) a jeho fulltextový index
// (docs/HLEDANI-DOKUMENTY.md). Řádek vzniká při uložení souboru druhu dokument (stav ceka), worker v aplikaci
// ho zpracuje po jednom. Generovaný sloupec vyhledavani se počítá stejně jako u web_obsah (bez diakritiky).
// Konfigurace cs_bez slouží jen pro úryvky (ts_headline): porovnává bez diakritiky, ale vrací původní text.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE soubory_text (
      soubor_id uuid PRIMARY KEY REFERENCES soubory(id) ON DELETE CASCADE,
      stav text NOT NULL DEFAULT 'ceka',           -- ceka | zpracovava | hotovo | bez_textu | nepodporovano | chyba
      zdroj text,                                  -- vrstva | ocr | docx | xlsx | pptx | odt | antiword | rtf | obrazek
      text text,
      stran integer,
      ma_vrstvu boolean,
      chyba text,
      poznamka text,                               -- např. „OCR jen prvních 300 stran“, „text zkrácen“
      pokusu integer NOT NULL DEFAULT 0,
      priorita smallint NOT NULL DEFAULT 0,        -- „Zpracovat teď“ = 1 (přednostně)
      zarazeno_at timestamptz NOT NULL DEFAULT now(),
      dalsi_pokus_at timestamptz,                  -- odklad po chybě
      zacatek_at timestamptz,
      zpracovano_at timestamptz,
      trvani_ms integer,
      vyhledavani tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(lower(text)))) STORED
    );
    CREATE INDEX soubory_text_fts_idx ON soubory_text USING gin (vyhledavani);
    CREATE INDEX soubory_text_fronta_idx ON soubory_text (stav, priorita DESC, zarazeno_at);

    -- úryvky: slova bez diakritiky a velkých písmen, ale text ve výsledku zůstává původní
    CREATE TEXT SEARCH CONFIGURATION cs_bez (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION cs_bez
      ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part, numword, numhword, hword_numpart
      WITH unaccent, simple;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TEXT SEARCH CONFIGURATION IF EXISTS cs_bez;
    DROP TABLE IF EXISTS soubory_text;
  `.execute(db);
}
