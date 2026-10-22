// Stránka Můj účet (náhrada aplikace MůjÚčet): žádosti o změnu přihlašovacího telefonu, které schvaluje úřad
// (Správa → Účty → Změny telefonu). Telefon je přihlašovací klíč účtu, proto ho občan nemění sám.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE uzivatele_zmeny_telefonu (
      id serial PRIMARY KEY,
      uzivatel_id uuid NOT NULL REFERENCES uzivatele(id) ON DELETE CASCADE,
      telefon_stary text NOT NULL,
      telefon_novy text NOT NULL,
      duvod text NOT NULL DEFAULT '',
      stav text NOT NULL DEFAULT 'ceka',            -- ceka | schvaleno | zamitnuto | zruseno
      vyrizil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vyrizeno_at timestamptz,
      vytvoreno_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX uzivatele_zmeny_telefonu_stav_idx ON uzivatele_zmeny_telefonu (stav, vytvoreno_at);
    -- jedna čekající žádost na účet
    CREATE UNIQUE INDEX uzivatele_zmeny_telefonu_ceka_idx ON uzivatele_zmeny_telefonu (uzivatel_id) WHERE stav = 'ceka';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS uzivatele_zmeny_telefonu`.execute(db);
}
