// Veřejná statistika návštěvnosti (/navstevnost): denní agregáty z access logů reverzní proxy. Ukládají se JEN
// počty — žádné IP adresy, prohlížeče ani jiné údaje o návštěvnících (jedinečnost se počítá v paměti při přepočtu).
// Dny přítomné v logu se při každém přepočtu přepíší, starší zůstávají (historie roste).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE navstevnost_den (
      den date NOT NULL,
      sekce text NOT NULL,                       -- web, infokanal, ucet, rezervace, spolujizda, eknihy
      zobrazeni integer NOT NULL DEFAULT 0,      -- zobrazení stránek lidmi
      navstevnici integer NOT NULL DEFAULT 0,    -- různá zařízení za den (IP + prohlížeč, neukládá se)
      stazeni integer NOT NULL DEFAULT 0,        -- stažené dokumenty (PDF, DOC, EPUB …)
      pozadavky integer NOT NULL DEFAULT 0,      -- všechny požadavky vč. robotů a statických souborů
      boti integer NOT NULL DEFAULT 0,           -- požadavky robotů
      PRIMARY KEY (den, sekce)
    )
  `.execute(db);
  await sql`
    CREATE TABLE navstevnost_stranky (
      den date NOT NULL,
      sekce text NOT NULL,
      cesta text NOT NULL,                       -- normalizovaná cesta (bez dotazu, identifikátorů a tokenů)
      zobrazeni integer NOT NULL,
      navstevnici integer NOT NULL,
      PRIMARY KEY (den, sekce, cesta)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS navstevnost_stranky`.execute(db);
  await sql`DROP TABLE IF EXISTS navstevnost_den`.execute(db);
}
