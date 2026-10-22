// Přechod z VlastiKanálu (22. 10. 2026): převod odběratelů a historie hlášení, interní odesílací API
// (náhrada POST /api/send VlastiKanálu) a příchozí SMS.
//  - ik_odberatele.prevod_id = id odběratele ve VlastiKanálu (idempotentní převod),
//    mujucet_cislo = číslo účtu MujÚčtu (= uzivatele.cislo); vazba uzivatel_id se dopáruje, až účet v DB bude.
//  - ik_hlaseni.prevod_id = id hlášení ve VlastiKanálu, souhrn = počty příjemců převedené historie
//    (jednotliví příjemci se nepřevádějí).
//  - ik_odchozi = odchozí fronta interního API (jednotlivé SMS a e-maily aplikací obce) s opakováním.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE ik_odberatele
      ADD COLUMN prevod_id integer UNIQUE,
      ADD COLUMN mujucet_cislo integer;
    CREATE INDEX ik_odberatele_mujucet_idx ON ik_odberatele (mujucet_cislo) WHERE mujucet_cislo IS NOT NULL;

    ALTER TABLE ik_hlaseni
      ADD COLUMN prevod_id integer UNIQUE,
      ADD COLUMN souhrn jsonb;

    CREATE TABLE ik_odchozi (
      id bigserial PRIMARY KEY,
      davka uuid NOT NULL,                          -- jeden požadavek API (vrací se jako id)
      zdroj text NOT NULL DEFAULT '',               -- rezervace | spolujizda | infokanal | …
      kanal text NOT NULL,                          -- sms | email
      kontakt text NOT NULL,
      sms_text text,
      email_predmet text,
      email_text text,
      email_html text,
      stav text NOT NULL DEFAULT 'ceka',            -- ceka | odesila_se | odeslano | doruceno | selhalo | vzdano
      pokusy integer NOT NULL DEFAULT 0,
      posledni_chyba text,
      brana_id text,
      dalsi_pokus_at timestamptz,
      zabrano_at timestamptz,
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      odeslano_at timestamptz,
      doruceno_at timestamptz
    );
    CREATE INDEX ik_odchozi_ceka_idx ON ik_odchozi (kanal, id) WHERE stav = 'ceka';
    CREATE INDEX ik_odchozi_davka_idx ON ik_odchozi (davka);
    CREATE INDEX ik_odchozi_brana_idx ON ik_odchozi (brana_id) WHERE brana_id IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS ik_odchozi;
    ALTER TABLE ik_hlaseni DROP COLUMN IF EXISTS souhrn, DROP COLUMN IF EXISTS prevod_id;
    DROP INDEX IF EXISTS ik_odberatele_mujucet_idx;
    ALTER TABLE ik_odberatele DROP COLUMN IF EXISTS mujucet_cislo, DROP COLUMN IF EXISTS prevod_id;
  `.execute(db);
}
