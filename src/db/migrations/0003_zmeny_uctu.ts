// Citlivé změny účtu: nový e-mail čeká na potvrzení kódem, než začne platit pro přihlášení heslem.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE uzivatele
      ADD COLUMN email_cekajici text,               -- nový e-mail, kterému jsme poslali kód (ještě neplatí)
      ADD COLUMN email_cekajici_at timestamptz;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE uzivatele DROP COLUMN email_cekajici, DROP COLUMN email_cekajici_at;`.execute(db);
}
