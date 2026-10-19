// Soubory (přílohy, obrázky, loga) + úřední deska + povinně zveřejňované informace (vyhláška 515/2020 Sb.).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS unaccent;
    -- unaccent() není IMMUTABLE → obal pro indexy fulltextu (čeština bez diakritiky)
    CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

    CREATE TABLE soubory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      druh text NOT NULL,                           -- dokument | obrazek | logo
      puvodni_nazev text NOT NULL,                  -- jak se jmenoval u uživatele (pro stažení)
      mime text NOT NULL,                           -- zjištěno z OBSAHU souboru, ne z přípony
      pripona text NOT NULL,
      velikost integer NOT NULL,
      sirka integer,
      vyska integer,
      alt text NOT NULL DEFAULT '',                 -- popis obrázku pro nevidomé (povinný při vložení do obsahu)
      sha256 text NOT NULL,
      zdroj_url text,                               -- import: odkud se soubor stáhl (deduplikace)
      nahral_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vytvoren_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX soubory_sha_idx ON soubory (sha256);
    CREATE INDEX soubory_zdroj_idx ON soubory (zdroj_url) WHERE zdroj_url IS NOT NULL;

    CREATE TABLE ud_kategorie (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      nazev text NOT NULL,
      min_dni integer NOT NULL DEFAULT 0,           -- zákonná minimální doba vyvěšení (dny), 0 = bez minima
      vychozi_dni integer NOT NULL DEFAULT 15,      -- předvyplněná doba vyvěšení; 0 = do odvolání
      rozpocet boolean NOT NULL DEFAULT false,      -- rozpočtová dokumentace (zák. 250/2000 Sb.)
      poradi integer NOT NULL DEFAULT 100,
      aktivni boolean NOT NULL DEFAULT true
    );

    CREATE TABLE ud_dokumenty (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nazev text NOT NULL,
      kategorie_id integer NOT NULL REFERENCES ud_kategorie(id),
      cislo_jednaci text NOT NULL DEFAULT '',
      puvodce text NOT NULL DEFAULT '',             -- kdo dokument vydal (u oznámení jiných úřadů)
      popis text NOT NULL DEFAULT '',
      vyveseno_od timestamptz NOT NULL,
      sejmuto_do timestamptz,                       -- NULL = do odvolání (rozpočet: do zveřejnění nového)
      sejmuti_duvod text NOT NULL DEFAULT '',       -- předčasné sejmutí / nahrazení novým dokumentem
      typ_rozpoctu text,                            -- navrh_rozpoctu | rozpocet | navrh_vyhledu | vyhled | navrh_zu | zaverecny_ucet | rozpoctove_opatreni
      rok integer,
      hlaseni_id uuid,                              -- rozesláno přes infokanál
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      puvodni_url text,                             -- import ze starého webu
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz                        -- koš (obnovitelné)
    );
    CREATE INDEX ud_dokumenty_vyveseni_idx ON ud_dokumenty (vyveseno_od, sejmuto_do);
    CREATE INDEX ud_dokumenty_fts_idx ON ud_dokumenty
      USING gin (to_tsvector('simple', f_unaccent(lower(nazev || ' ' || popis || ' ' || cislo_jednaci))));

    CREATE TABLE ud_prilohy (
      dokument_id uuid NOT NULL REFERENCES ud_dokumenty(id) ON DELETE CASCADE,
      soubor_id uuid NOT NULL REFERENCES soubory(id),
      poradi integer NOT NULL DEFAULT 0,
      PRIMARY KEY (dokument_id, soubor_id)
    );

    CREATE TABLE pi_body (
      klic text PRIMARY KEY,                        -- bod struktury dle přílohy vyhlášky 515/2020 Sb. (např. '4.3')
      obsah_html text NOT NULL DEFAULT '',
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      upravil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL
    );

    INSERT INTO ud_kategorie (slug, nazev, min_dni, vychozi_dni, rozpocet, poradi) VALUES
      ('vyhlasky', 'Vyhlášky a nařízení obce', 15, 15, false, 1),
      ('zastupitelstvo', 'Usnesení a zápisy zastupitelstva', 0, 15, false, 2),
      ('zamery', 'Záměry obce s majetkem', 15, 15, false, 3),
      ('rozpocet', 'Rozpočet a závěrečný účet', 0, 0, true, 4),
      ('jine-urady', 'Oznámení jiných úřadů', 0, 15, false, 5),
      ('verejne-vyhlasky', 'Veřejné vyhlášky', 15, 15, false, 6),
      ('ostatni', 'Ostatní', 0, 15, false, 7);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS pi_body, ud_prilohy, ud_dokumenty, ud_kategorie, soubory;`.execute(db);
}
