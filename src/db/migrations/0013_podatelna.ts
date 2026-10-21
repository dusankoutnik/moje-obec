// Elektronická podatelna: podání z veřejného formuláře (bez elektronického podpisu a přílohy).
// Číslo podání = rok + pořadí v roce (EP-2026-0001). Nic se nemaže samo: uchovat_do jen označí podání,
// u kterého uplynula doba uchování podle spisového a skartačního plánu (vyřadí ho úřad ve skartačním řízení).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE pod_podani (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rok integer NOT NULL,
      poradi integer NOT NULL,
      cislo text NOT NULL UNIQUE,                    -- EP-<rok>-<pořadí>, sděluje se podateli
      jmeno text NOT NULL,                           -- jméno a příjmení
      ulice text NOT NULL DEFAULT '',
      obec text NOT NULL DEFAULT '',
      psc text NOT NULL DEFAULT '',
      telefon text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      predmet text NOT NULL,
      text text NOT NULL,
      prijato_at timestamptz NOT NULL DEFAULT now(),
      uchovat_do date NOT NULL,                      -- konec doby uchování (prijato + podatelna.uchovani_let)
      odeslano_uradu_at timestamptz,                 -- e-mail na adresu podatelny odešel
      potvrzeni_at timestamptz,                      -- automatické potvrzení doručení podateli odešlo
      chyba_odeslani text NOT NULL DEFAULT '',
      vyrizeno_at timestamptz,
      vyridil_id uuid REFERENCES uzivatele(id) ON DELETE SET NULL,
      poznamka text NOT NULL DEFAULT '',             -- interní poznámka úřadu (např. č. j. ve spisové službě)
      UNIQUE (rok, poradi)
    );
    CREATE INDEX pod_podani_prijato_idx ON pod_podani (prijato_at DESC);
    CREATE INDEX pod_podani_nevyrizene_idx ON pod_podani (prijato_at) WHERE vyrizeno_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS pod_podani;`.execute(db);
}
