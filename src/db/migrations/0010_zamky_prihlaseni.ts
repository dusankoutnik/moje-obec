// Zámek přihlášení heslem po opakovaných chybách (code review S5): čítač v DB podle klíče
// („email:<adresa>“ pro přihlášení, „ucet:<id>“ pro ověření heslem před citlivou změnou).
// Klíčuje se e-mailem, ne existencí účtu — neexistující adresa se zamyká stejně (žádná enumerace).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE prihlaseni_zamky (
      klic text PRIMARY KEY,
      chyby integer NOT NULL DEFAULT 0,
      posledni_chyba_at timestamptz NOT NULL DEFAULT now(),
      zamceno_do timestamptz
    );
    CREATE INDEX prihlaseni_zamky_posledni_idx ON prihlaseni_zamky (posledni_chyba_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS prihlaseni_zamky;`.execute(db);
}
