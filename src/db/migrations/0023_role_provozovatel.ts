// Role „provozovatel“ (v UI „Bůh — provozovatel“) nad administrátorem: všechna práva admina, navíc vzhled webu
// a správa rolí; účet s ní je chráněný (mění ho jen jiný provozovatel). Migrace roli nikomu nepřiděluje.
// Číslo 0022 je rezervované pro souběžnou práci (rubriky aktualit).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY['web','deska','redaktor','kviz','ucetni','vstupne','spravce','admin','provozovatel']::text[]) NOT VALID;
  `.execute(db);
  // existující řádky ověřit zvlášť (jako v 0009 a 0011) — účet s neznámou rolí nesmí shodit migraci
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
  // provozovatel se při návratu stane administrátorem (aby účet o práva nepřišel úplně)
  await sql`
    UPDATE uzivatele
       SET role = (SELECT array_agg(DISTINCT r ORDER BY r) FROM unnest(array_remove(role, 'provozovatel') || ARRAY['admin']) AS r)
     WHERE 'provozovatel' = ANY(role);
    ALTER TABLE uzivatele DROP CONSTRAINT IF EXISTS uzivatele_role_check;
    ALTER TABLE uzivatele ADD CONSTRAINT uzivatele_role_check
      CHECK (role <@ ARRAY['web','deska','redaktor','kviz','ucetni','vstupne','spravce','admin']::text[]) NOT VALID;
  `.execute(db);
}
