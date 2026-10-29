// Název termínu v rezervacích, pod kterým byla akce webu naposledy srovnaná. Když se termín v rezervacích
// přejmenuje a akce má pořád ten starý název (redaktor ho neměnil), převezme nový — i zveřejněná.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE web_obsah ADD COLUMN rezervace_nazev text`.execute(db);
  // akce založené synchronizací: název z první revize (= název termínu v době založení);
  // ostatní propojené se srovnají při další synchronizaci (bez změny názvu)
  await sql`
    UPDATE web_obsah o SET rezervace_nazev = r.data->>'titulek'
    FROM (
      SELECT DISTINCT ON (obsah_id) obsah_id, data FROM web_revize ORDER BY obsah_id, vytvoreno_at
    ) r
    WHERE r.obsah_id = o.id AND o.rezervace_ref IS NOT NULL AND o.zdroj = 'rezervace'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE web_obsah DROP COLUMN rezervace_nazev`.execute(db);
}
