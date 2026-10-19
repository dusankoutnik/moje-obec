// Modul infokanál: odběratelé, kategorie s opt-outem, hlášení, fronta příjemců.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ik_kategorie (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      nazev text NOT NULL,
      povinna boolean NOT NULL DEFAULT false,       -- true = dostává každý (nelze se odhlásit)
      poradi integer NOT NULL DEFAULT 100
    );

    CREATE TABLE ik_odberatele (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      jmeno text NOT NULL DEFAULT '',
      telefon text UNIQUE,                          -- E.164; NULL = jen e-mail
      email text,                                   -- NULL = jen telefon
      cast_obce text NOT NULL DEFAULT '',
      kanal text NOT NULL DEFAULT 'sms',            -- sms | email | smisene (důležité SMS, ostatní e-mail)
      token text NOT NULL UNIQUE,                   -- odhlašovací odkaz v patičce e-mailů
      overen_at timestamptz,                        -- bez ověření se nic neposílá
      odhlasen_at timestamptz,
      zdroj text NOT NULL DEFAULT 'web',            -- web | sms | urad | import | ucet
      souhlas_at timestamptz,                       -- evidence souhlasu (GDPR)
      uzivatel_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      poznamka text NOT NULL DEFAULT '',
      vytvoren_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX ik_odberatele_email_idx ON ik_odberatele (lower(email)) WHERE email IS NOT NULL;
    CREATE INDEX ik_odberatele_uzivatel_idx ON ik_odberatele (uzivatel_id);

    CREATE TABLE ik_optouty (
      odberatel_id uuid NOT NULL REFERENCES ik_odberatele(id) ON DELETE CASCADE,
      kategorie_id integer NOT NULL REFERENCES ik_kategorie(id) ON DELETE CASCADE,
      PRIMARY KEY (odberatel_id, kategorie_id)
    );

    CREATE TABLE ik_hlaseni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      autor_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      kategorie_id integer NOT NULL REFERENCES ik_kategorie(id),
      krizove boolean NOT NULL DEFAULT false,       -- oba kanály všem bez ohledu na preference
      cil text NOT NULL DEFAULT 'vse',              -- vse | casti
      cil_detail jsonb NOT NULL DEFAULT '[]',       -- seznam částí obce
      sms_text text,                                -- NULL = kanál SMS vypnut
      email_predmet text,
      email_text text,                              -- NULL = kanál e-mail vypnut
      email_html text,
      clanek_titulek text,                          -- NULL = bez článku na webu
      clanek_html text,
      stav text NOT NULL DEFAULT 'odesila_se',      -- naplanovano | odesila_se | hotovo | zruseno
      naplanovano_na timestamptz,
      zdroj_automatu text,                          -- chmu | cez | voda — hlášení vzniklé automaticky
      vytvoreno_at timestamptz NOT NULL DEFAULT now(),
      dokonceno_at timestamptz
    );

    CREATE TABLE ik_prijemci (
      id bigserial PRIMARY KEY,
      hlaseni_id uuid NOT NULL REFERENCES ik_hlaseni(id) ON DELETE CASCADE,
      odberatel_id uuid REFERENCES ik_odberatele(id) ON DELETE SET NULL,
      kanal text NOT NULL,                          -- sms | email
      kontakt text NOT NULL,                        -- hodnota v době odeslání
      stav text NOT NULL DEFAULT 'ceka',            -- ceka | odeslano | doruceno | selhalo | vzdano
      brana_id text,                                -- id zprávy u poskytovatele SMS (doručenky)
      pokusy integer NOT NULL DEFAULT 0,
      posledni_chyba text,
      odeslano_at timestamptz,
      doruceno_at timestamptz
    );
    CREATE INDEX ik_prijemci_hlaseni_idx ON ik_prijemci (hlaseni_id, stav);
    CREATE INDEX ik_prijemci_brana_idx ON ik_prijemci (brana_id) WHERE brana_id IS NOT NULL;

    INSERT INTO ik_kategorie (slug, nazev, povinna, poradi) VALUES
      ('krizove', 'Krizové zprávy', true, 0),
      ('hlaseni', 'Obecná hlášení', true, 1),
      ('kultura', 'Pozvánky — kultura a akce', false, 2),
      ('sport', 'Pozvánky — sport a cvičení', false, 3),
      ('sluzby', 'Komerční služby ve vsi', false, 4),
      ('pocasi', 'Výstrahy ČHMÚ (počasí)', false, 5),
      ('elektrina', 'Odstávky elektřiny', false, 6),
      ('voda', 'Odstávky vody', false, 7);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ik_prijemci, ik_hlaseni, ik_optouty, ik_odberatele, ik_kategorie;`.execute(
    db,
  );
}
