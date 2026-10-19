// Role pro obecní web (2026-10-18): dřívější „redaktor“ smí web, úřední desku i hlášení. Nově jsou zvlášť:
// web (obsah webu), deska (úřední deska a rozpočet), redaktor (hlášení infokanálu — jako v MůjÚčtu), vstupne.
// Stávající redaktoři dostanou web + deska, aby o nic nepřišli.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE uzivatele
       SET role = (SELECT array_agg(DISTINCT r ORDER BY r) FROM unnest(role || ARRAY['web','deska']) AS r)
     WHERE 'redaktor' = ANY(role);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE uzivatele
       SET role = ARRAY(SELECT r FROM unnest(role) AS r WHERE r NOT IN ('web','deska','vstupne'));
  `.execute(db);
}
