// Opravy podle code review (19. 10. 2026):
// - fronta infokanálu: atomické zabrání řádku (stav odesila_se + zabrano_at), odklad po dočasné chybě,
//   částečný index na čekající příjemce;
// - úřední deska: nahrazení rozpočtové dokumentace je vratné (kdo dokument sejmul + původní stav);
// - audit_log podle času; CHECK na hodnoty rolí.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ik_prijemci
      ADD COLUMN zabrano_at timestamptz,
      ADD COLUMN dalsi_pokus_at timestamptz;
    CREATE INDEX ik_prijemci_ceka_idx ON ik_prijemci (kanal, id) WHERE stav = 'ceka';
    CREATE INDEX ik_prijemci_odesila_idx ON ik_prijemci (zabrano_at) WHERE stav = 'odesila_se';

    ALTER TABLE ud_dokumenty
      ADD COLUMN nahrazeno_id uuid REFERENCES ud_dokumenty(id) ON DELETE SET NULL,
      ADD COLUMN pred_nahrazenim_do timestamptz,
      ADD COLUMN pred_nahrazenim_duvod text;
    CREATE INDEX ud_dokumenty_nahrazeno_idx ON ud_dokumenty (nahrazeno_id) WHERE nahrazeno_id IS NOT NULL;

    CREATE INDEX audit_log_ts_idx ON audit_log (ts);

    -- NOT VALID: platí pro nové zápisy; existující řádky se ověří zvlášť, aby migrace nespadla na starých datech
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY['web','deska','redaktor','ucetni','vstupne','spravce','admin']::text[]) NOT VALID;
  `.execute(db);
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
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    DROP INDEX IF EXISTS audit_log_ts_idx;
    DROP INDEX IF EXISTS ud_dokumenty_nahrazeno_idx;
    ALTER TABLE ud_dokumenty
      DROP COLUMN IF EXISTS pred_nahrazenim_duvod,
      DROP COLUMN IF EXISTS pred_nahrazenim_do,
      DROP COLUMN IF EXISTS nahrazeno_id;
    DROP INDEX IF EXISTS ik_prijemci_odesila_idx;
    DROP INDEX IF EXISTS ik_prijemci_ceka_idx;
    ALTER TABLE ik_prijemci DROP COLUMN IF EXISTS dalsi_pokus_at, DROP COLUMN IF EXISTS zabrano_at;
  `.execute(db);
}
