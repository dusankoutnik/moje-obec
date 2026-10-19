// Obecní web: stránky, aktuality, akce a odkazy v menu (jedna tabulka obsahu s koncepty a revizemi), galerie,
// dokumenty ke stažení, dotace (povinná publicita dárců), přesměrování starých adres.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE web_kategorie (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      nazev text NOT NULL,
      poradi integer NOT NULL DEFAULT 100
    );

    CREATE TABLE web_obsah (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      typ text NOT NULL,                            -- stranka | aktualita | akce | odkaz (položka menu)
      titulek text NOT NULL DEFAULT '',
      slug text NOT NULL,
      nadrazena_id uuid REFERENCES web_obsah(id) ON DELETE SET NULL,  -- stránky a odkazy: strom menu (max 2 úrovně)
      poradi integer NOT NULL DEFAULT 0,
      v_menu boolean NOT NULL DEFAULT true,
      odkaz_url text NOT NULL DEFAULT '',           -- jen typ odkaz
      perex text NOT NULL DEFAULT '',
      obsah_html text NOT NULL DEFAULT '',          -- vždy sanitizované HTML
      obrazek_id uuid REFERENCES soubory(id) ON DELETE SET NULL,
      kategorie_id integer REFERENCES web_kategorie(id) ON DELETE SET NULL,
      datum timestamptz,                            -- aktualita: datum zveřejnění; akce: začátek
      akce_konec timestamptz,
      akce_cely_den boolean NOT NULL DEFAULT false,
      akce_misto text NOT NULL DEFAULT '',
      stav text NOT NULL DEFAULT 'koncept',         -- koncept | zverejneno
      koncept jsonb,                                -- rozpracovaná úprava zveřejněného obsahu (na webu ještě není)
      koncept_at timestamptz,
      zverejneno_at timestamptz,
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      upravil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      zdroj text NOT NULL DEFAULT '',               -- '' | import | infokanal
      puvodni_url text,
      hlaseni_id uuid,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz                        -- koš (obnovitelné)
    );
    CREATE UNIQUE INDEX web_obsah_slug_idx ON web_obsah (typ, slug) WHERE smazano_at IS NULL;
    CREATE INDEX web_obsah_typ_idx ON web_obsah (typ, stav, datum DESC);
    CREATE INDEX web_obsah_strom_idx ON web_obsah (nadrazena_id, poradi);
    CREATE INDEX web_obsah_fts_idx ON web_obsah USING gin (
      to_tsvector('simple', f_unaccent(lower(titulek || ' ' || perex || ' ' || regexp_replace(obsah_html, '<[^>]+>', ' ', 'g'))))
    );

    CREATE TABLE web_revize (
      id bigserial PRIMARY KEY,
      obsah_id uuid NOT NULL REFERENCES web_obsah(id) ON DELETE CASCADE,
      data jsonb NOT NULL,                          -- snímek polí obsahu
      duvod text NOT NULL,                          -- zverejneni | koncept | obnoveni
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vytvoreno_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX web_revize_obsah_idx ON web_revize (obsah_id, vytvoreno_at DESC);

    CREATE TABLE web_galerie (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nazev text NOT NULL,
      slug text NOT NULL,
      popis text NOT NULL DEFAULT '',
      datum date,
      stav text NOT NULL DEFAULT 'koncept',
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      puvodni_url text,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz
    );
    CREATE UNIQUE INDEX web_galerie_slug_idx ON web_galerie (slug) WHERE smazano_at IS NULL;

    CREATE TABLE web_galerie_fotky (
      galerie_id uuid NOT NULL REFERENCES web_galerie(id) ON DELETE CASCADE,
      soubor_id uuid NOT NULL REFERENCES soubory(id),
      poradi integer NOT NULL DEFAULT 0,
      popisek text NOT NULL DEFAULT '',
      PRIMARY KEY (galerie_id, soubor_id)
    );

    CREATE TABLE web_dokumenty (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nazev text NOT NULL,
      popis text NOT NULL DEFAULT '',
      skupina text NOT NULL DEFAULT '',             -- např. Formuláře, Odpady, Územní plán
      soubor_id uuid NOT NULL REFERENCES soubory(id),
      poradi integer NOT NULL DEFAULT 100,
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz
    );

    CREATE TABLE web_dotace (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      projekt text NOT NULL,
      poskytovatel text NOT NULL DEFAULT '',
      text text NOT NULL DEFAULT '',                -- např. „Projekt … byl spolufinancován z …“
      odkaz text NOT NULL DEFAULT '',
      zobrazit_od date NOT NULL DEFAULT CURRENT_DATE,
      zobrazit_do date,                             -- konec povinné doby udržitelnosti; NULL = bez konce
      v_paticce boolean NOT NULL DEFAULT false,     -- i v patičce všech stránek
      poradi integer NOT NULL DEFAULT 100,
      stav text NOT NULL DEFAULT 'koncept',         -- koncept (rozpracovaný průvodce) | hotovo
      upozorneno_at timestamptz,                    -- správci dostali upozornění na blížící se konec
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      puvodni_url text,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      upraveno_at timestamptz NOT NULL DEFAULT now(),
      smazano_at timestamptz
    );

    CREATE TABLE web_dotace_loga (
      dotace_id uuid NOT NULL REFERENCES web_dotace(id) ON DELETE CASCADE,
      soubor_id uuid NOT NULL REFERENCES soubory(id),
      poradi integer NOT NULL DEFAULT 0,
      PRIMARY KEY (dotace_id, soubor_id)
    );

    CREATE TABLE web_presmerovani (
      stara_cesta text PRIMARY KEY,                 -- cesta + případný dotaz, bez domény (např. /2024/05/clanek/)
      nova_cesta text NOT NULL,
      pocet integer NOT NULL DEFAULT 0,
      posledni_at timestamptz,
      vytvoreno_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO web_kategorie (slug, nazev, poradi) VALUES
      ('obecni-urad', 'Obecní úřad informuje', 1),
      ('kultura', 'Kultura a akce', 2),
      ('sport', 'Sport', 3),
      ('zpravodaj', 'Zpravodaj', 4);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS web_presmerovani, web_dotace_loga, web_dotace, web_dokumenty, web_galerie_fotky,
    web_galerie, web_revize, web_obsah, web_kategorie;`.execute(db);
}
