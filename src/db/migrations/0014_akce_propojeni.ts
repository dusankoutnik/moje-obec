// Akce: propojení s rezervačním systémem a pozvánky v Aktualitách (docs/AKCE-PROPOJENI.md).
// rezervace_ref = termín v kalendářním API rezervací: r<id> (rezervace), s<id> (celá série), e<id> (předprodej);
// unikátní jen mezi nesmazanými (záznam v koši si odkaz může nechat). rezervace_termin = podpis termínu z API
// v okamžiku propojení / převzetí — když se v rezervacích změní, ukáže se to ve správě (web se sám nemění).
// web_akce_ignorovane = termíny, které redaktor označil „jen v kalendáři“ (koncept se pro ně znovu nezakládá).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE web_obsah ADD COLUMN rezervace_ref text;
    ALTER TABLE web_obsah ADD COLUMN rezervace_termin text;
    ALTER TABLE web_obsah ADD COLUMN v_aktualitach boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX web_obsah_rezervace_ref_idx ON web_obsah (rezervace_ref)
      WHERE rezervace_ref IS NOT NULL AND smazano_at IS NULL;
    CREATE INDEX web_obsah_v_aktualitach_idx ON web_obsah (zverejneno_at DESC)
      WHERE v_aktualitach AND typ = 'akce';
    CREATE TABLE web_akce_ignorovane (
      ref text PRIMARY KEY,
      nazev text NOT NULL DEFAULT '',
      kdo uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      kdy timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS web_akce_ignorovane;
    DROP INDEX IF EXISTS web_obsah_v_aktualitach_idx;
    DROP INDEX IF EXISTS web_obsah_rezervace_ref_idx;
    ALTER TABLE web_obsah DROP COLUMN IF EXISTS v_aktualitach;
    ALTER TABLE web_obsah DROP COLUMN IF EXISTS rezervace_termin;
    ALTER TABLE web_obsah DROP COLUMN IF EXISTS rezervace_ref;
  `.execute(db);
}
