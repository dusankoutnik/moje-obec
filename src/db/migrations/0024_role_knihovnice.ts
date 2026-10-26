// Role „knihovnice“: aktuality v rubrice knihovny (profil obce web.rubrika_knihovny) a jejích podrubrikách.
import { sql, type Kysely } from 'kysely';

const S = ['web', 'deska', 'redaktor', 'kviz', 'ucetni', 'vstupne', 'spravce', 'admin', 'provozovatel'];

async function omezeni(db: Kysely<unknown>, role: string[]) {
  await sql`
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY[${sql.raw(role.map((r) => `'${r}'`).join(','))}]::text[]) NOT VALID;
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

export async function up(db: Kysely<unknown>): Promise<void> {
  await omezeni(db, [...S, 'knihovnice']);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE uzivatele SET role = array_remove(role, 'knihovnice') WHERE 'knihovnice' = ANY(role)`.execute(
    db,
  );
  await omezeni(db, S);
}
