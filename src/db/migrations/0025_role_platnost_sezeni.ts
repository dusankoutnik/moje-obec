// Dočasné role a přehled přihlášených zařízení (Administrace → Systém → Role, 26. 10. 2026):
//  - role_platnost: role účtu, která platí jen do daného okamžiku (po něm ji plánovač odebere; kontrola oprávnění
//    ji mezitím ignoruje — src/moduly/ucty/role-platnost.ts). Bez řádku = role platí trvale.
//  - sezeni: kdy sezení vzniklo, kdy bylo naposledy aktivní a zkrácený popis prohlížeče („Firefox · Windows“) pro
//    přehled zařízení a odhlášení na dálku. Celý User-Agent ani IP adresa se k sezení neukládají.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE role_platnost (
      uzivatel_id uuid NOT NULL REFERENCES uzivatele(id) ON DELETE CASCADE,
      role text NOT NULL,
      plati_do timestamptz NOT NULL,
      pridal_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (uzivatel_id, role)
    );
    CREATE INDEX role_platnost_plati_do_idx ON role_platnost (plati_do);

    ALTER TABLE sezeni
      ADD COLUMN vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN aktivita_at timestamptz,
      ADD COLUMN prohlizec text;
    CREATE INDEX sezeni_uzivatel_idx ON sezeni ((data->>'uzivatelId'));
    CREATE INDEX audit_log_akce_ts_idx ON audit_log (akce, ts DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS audit_log_akce_ts_idx;
    DROP INDEX IF EXISTS sezeni_uzivatel_idx;
    ALTER TABLE sezeni DROP COLUMN IF EXISTS prohlizec, DROP COLUMN IF EXISTS aktivita_at,
      DROP COLUMN IF EXISTS vytvoreno_at;
    DROP TABLE IF EXISTS role_platnost;
  `.execute(db);
}
