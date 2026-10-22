// Převod účtů z MůjÚčtu: číslo účtu (= id v MůjÚčtu a v aplikacích rezervace/eKnihy), posouzení rezidenta,
// údaje navíc (jsonb) a způsob ověření klienta OIDC u tokenového endpointu.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE SEQUENCE uzivatele_cislo_seq AS integer START 1;
    ALTER TABLE uzivatele
      ADD COLUMN cislo integer,                     -- číslo účtu; převedené účty = id z MůjÚčtu, nové = další ze sekvence
      ADD COLUMN rezident_posouzen_at timestamptz,  -- kdy úřad posoudil, zda je rezident
      ADD COLUMN rezident_posouzen_by integer,      -- číslo účtu správce, který posoudil
      ADD COLUMN navic jsonb NOT NULL DEFAULT '{}'::jsonb; -- údaje z MůjÚčtu, které platforma zatím nepoužívá
    -- stávající účty platformy (demo, testy) dostanou čísla až za nejvyšším možným převáděným id: řeší převodní skript
    -- posunutím sekvence; tady jen v pořadí založení
    UPDATE uzivatele u SET cislo = s.n
      FROM (SELECT id, nextval('uzivatele_cislo_seq') AS n FROM uzivatele ORDER BY vytvoren_at, id) s
      WHERE u.id = s.id;
    ALTER TABLE uzivatele
      ALTER COLUMN cislo SET DEFAULT nextval('uzivatele_cislo_seq'),
      ALTER COLUMN cislo SET NOT NULL,
      ADD CONSTRAINT uzivatele_cislo_key UNIQUE (cislo);
    ALTER SEQUENCE uzivatele_cislo_seq OWNED BY uzivatele.cislo;

    ALTER TABLE oidc_klienti
      ADD COLUMN auth_metoda text NOT NULL DEFAULT 'client_secret_basic'; -- client_secret_basic | client_secret_post
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE oidc_klienti DROP COLUMN auth_metoda;
    ALTER TABLE uzivatele DROP COLUMN cislo, DROP COLUMN rezident_posouzen_at, DROP COLUMN rezident_posouzen_by,
      DROP COLUMN navic;
    DROP SEQUENCE IF EXISTS uzivatele_cislo_seq;
  `.execute(db);
}
