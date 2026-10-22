// Automatické výstrahy infokanálu (ČHMÚ, ČEZ, SčVK) — převzato z provozu VlastiKanálu (docs/MODULY.md).
// ik_vystrahy = jedna událost zdroje (ČHMÚ „jev|stupeň“, ČEZ id odstávky, SčVK id události) a co se s ní stalo;
// ik_vystrahy_zdroje = stav dotazování na zdroj (poslední úspěch, chyba, jednorázové upozornění při výpadku > 24 h).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE ik_vystrahy (
      id serial PRIMARY KEY,
      zdroj text NOT NULL,                          -- chmu | cez | scvk
      externi_id text NOT NULL,                     -- chmu: „jev|stupeň“; cez: id odstávky; scvk: id události
      stupen text,                                  -- chmu: yellow | orange | red
      titulek text NOT NULL,
      plati_od timestamptz,
      plati_do timestamptz,
      sms_text text,
      email_predmet text,
      email_text text,
      detail jsonb NOT NULL DEFAULT '{}',           -- zdrojová data (pro texty připomínek a změn)
      stav text NOT NULL,                           -- ceka (žlutá čeká na správce) | odeslano | zahozeno | preskoceno
      hlaseni_id uuid REFERENCES ik_hlaseni(id) ON DELETE SET NULL,  -- první hlášení, kterým se rozeslalo
      pripomenuto_at timestamptz,
      zruseno_at timestamptz,
      rozhodl_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      rozhodnuto_at timestamptz,
      vytvoreno_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ik_vystrahy_klic_idx ON ik_vystrahy (zdroj, externi_id);
    CREATE INDEX ik_vystrahy_stav_idx ON ik_vystrahy (stav, plati_do);

    CREATE TABLE ik_vystrahy_zdroje (
      zdroj text PRIMARY KEY,
      posledni_ok timestamptz,
      posledni_pokus timestamptz,
      posledni_chyba text,
      chyba_od timestamptz,                         -- od kdy zdroj nepřetržitě selhává (úspěch = NULL)
      alarm_at timestamptz,                         -- upozornění na výpadek odešlo (do dalšího úspěchu jen jednou)
      razitko text                                  -- chmu: naposledy zpracovaný soubor CAP
    );

    -- kategorie odběru (odhlásitelné; doručují se jako obecná hlášení) — v čisté instalaci už jsou z 0002
    INSERT INTO ik_kategorie (slug, nazev, povinna, poradi) VALUES
      ('pocasi', 'Výstrahy ČHMÚ (počasí)', false, 5),
      ('elektrina', 'Odstávky elektřiny', false, 6),
      ('voda', 'Odstávky vody', false, 7)
    ON CONFLICT (slug) DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS ik_vystrahy_zdroje, ik_vystrahy;`.execute(db);
}
