// Fotogalerie „jen pro příspěvky“: zveřejněná galerie, která se neukazuje na stránce Fotogalerie, ale jde vložit
// do textu příspěvku (editor). Koncept zůstává neveřejný úplně.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE web_galerie ADD COLUMN v_seznamu boolean NOT NULL DEFAULT true`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE web_galerie DROP COLUMN v_seznamu`.execute(db);
}
