// Modul „kvíz“ (obdoba hospodských kvízů): kategorie a otázky z YAML balíků, hráči (účet nebo anonymní cookie),
// odpovědi a rozehraná otázka hráče. Otázky se nikdy nemažou — odstraněné z balíku jen přestanou být v balíku
// (v_baliku = false), aby zůstala historie odpovědí; úřad je může navíc vypnout (vypnuta_at).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE kviz_kategorie (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      nazev text NOT NULL,
      ikona text NOT NULL DEFAULT '',
      poradi integer NOT NULL DEFAULT 1000,          -- obec, region, okres, kraj, cr, eu, svet, … pak ostatní
      aktualizovano_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE kviz_otazky (
      id text PRIMARY KEY,                           -- id z balíku (např. „cr-001“)
      kategorie_id integer NOT NULL REFERENCES kviz_kategorie(id),
      otazka text NOT NULL,
      odpovedi text[] NOT NULL CHECK (cardinality(odpovedi) = 4),   -- první je vždy správná
      obtiznost smallint NOT NULL CHECK (obtiznost BETWEEN 1 AND 5),
      vysvetleni text NOT NULL DEFAULT '',
      zdroj text NOT NULL DEFAULT '',
      balik text NOT NULL DEFAULT '',                -- soubor, ze kterého otázka přišla
      v_baliku boolean NOT NULL DEFAULT true,        -- false = při posledním importu v balíku nebyla
      vypnuta_at timestamptz,                        -- vypnutá úřadem (správa kvízu)
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      aktualizovano_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX kviz_otazky_kategorie_idx ON kviz_otazky (kategorie_id);

    CREATE TABLE kviz_hraci (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      uzivatel_id uuid UNIQUE REFERENCES uzivatele(id) ON DELETE CASCADE,   -- NULL = anonymní hráč (cookie)
      reset_at timestamptz,                          -- průběžné skóre se počítá od tohoto okamžiku
      kategorie text[] NOT NULL DEFAULT '{}',        -- zvolené kategorie (slugy), prázdné = všechny
      otazka_id text REFERENCES kviz_otazky(id),     -- rozehraná otázka
      poradi smallint[],                             -- zamíchané pořadí odpovědí rozehrané otázky
      odpoved_id bigint,                             -- odpověď na rozehranou otázku (NULL = čeká na odpověď)
      kolo integer NOT NULL DEFAULT 1,
      kolo_od timestamptz NOT NULL DEFAULT now(),
      krok smallint NOT NULL DEFAULT 0,              -- zodpovězeno v tomto kole
      kolo_spravne smallint NOT NULL DEFAULT 0,
      posun smallint NOT NULL DEFAULT 0,             -- posun obtížnosti −1/0/+1 podle předchozího kola
      vytvoren_at timestamptz NOT NULL DEFAULT now(),
      posledni_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE kviz_odpovedi (
      id bigserial PRIMARY KEY,
      hrac_id uuid NOT NULL REFERENCES kviz_hraci(id) ON DELETE CASCADE,
      otazka_id text NOT NULL REFERENCES kviz_otazky(id),
      zvolena smallint NOT NULL,                     -- index odpovědi v datech (0 = správná)
      spravne boolean NOT NULL,
      ts timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX kviz_odpovedi_hrac_idx ON kviz_odpovedi (hrac_id, ts);
    CREATE INDEX kviz_odpovedi_otazka_idx ON kviz_odpovedi (otazka_id);

    -- nová role „kviz“ (správa kvízu)
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY['web','deska','redaktor','kviz','ucetni','vstupne','spravce','admin']::text[]) NOT VALID;
  `.execute(db);
  // existující řádky ověřit zvlášť (jako v 0009) — účet s neznámou rolí nesmí shodit migraci
  await sql`
    DO $$
    BEGIN
      ALTER TABLE uzivatele VALIDATE CONSTRAINT uzivatele_role_check;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'uzivatele_role_check: některý účet má neznámou roli — omezení platí jen pro nové zápisy';
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE uzivatele SET role = array_remove(role, 'kviz') WHERE 'kviz' = ANY(role);
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY['web','deska','redaktor','ucetni','vstupne','spravce','admin']::text[]) NOT VALID;
    DROP TABLE IF EXISTS kviz_odpovedi;
    DROP TABLE IF EXISTS kviz_hraci;
    DROP TABLE IF EXISTS kviz_otazky;
    DROP TABLE IF EXISTS kviz_kategorie;
  `.execute(db);
}
