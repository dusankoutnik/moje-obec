// Opravy podle auditu souladu se zákony (19. 10. 2026):
// - povinně zveřejňované informace: body 4.5–4.8 podle přílohy č. 1 vyhl. 515/2020 Sb. (dřív struktura staré
//   vyhl. 442/2006: 4.5 fax, 4.6 web, 4.7 e-podatelna, 4.8 další adresy) — texty úřadu se přenesou, nic se neztratí;
// - kategorie úřední desky: veřejnost archivu (dokumenty jiných úřadů se po sejmutí veřejně nezobrazují — GDPR),
//   pozvánky na zasedání zastupitelstva (nejméně 7 dní, § 93 zák. o obcích), poskytnuté informace (6 let, § 5 odst. 3
//   zák. 106/1999 Sb.);
// - index příloh podle souboru (kontrola, zda soubor patří k neveřejnému dokumentu).
import { sql, type Kysely } from 'kysely';

/** značka v nastavení: texty bodů 4.5–4.8 už jsou přečíslované podle vyhl. 515/2020 */
export const ZNACKA_PI_515 = 'pi_body_515';

/**
 * Přečíslování textů úřadu u bodů 4.5–4.8 (struktura 442/2006 → 515/2020).
 *
 * Samotné přečíslování idempotentní NENÍ: po prvním běhu je v klíči 4.5 adresa webu (dřív 4.6) a druhý běh by ji
 * vzal za fax a připojil k telefonům. Proto se provede jen jednou — po něm se zapíše značka do `nastaveni`
 * a další volání nic nedělají. Instalace, které migraci 0008 prošly dřív, než značka existovala, ji dostanou
 * v migraci 0010.
 *
 * Spojení dvou textů je prosté zřetězení HTML: obsah bodů je sanitizované HTML z editoru (bloky <p>, <ul>…),
 * takže se připojený text ukáže jako další odstavec. Výsledek už proběhlé migrace se tím nemění.
 */
export async function premapujPiBody(db: Kysely<unknown>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${ZNACKA_PI_515}))`.execute(db);
  const hotovo = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM nastaveni WHERE klic = ${ZNACKA_PI_515}`.execute(db);
  if (hotovo.rows[0]!.n > 0) return;
  await sql`
    -- 4.5 fax → připojit k 4.4 Telefonní čísla
    INSERT INTO pi_body (klic, obsah_html, upraveno_at, upravil_id)
      SELECT '4.4', obsah_html, upraveno_at, upravil_id FROM pi_body WHERE klic = '4.5' AND obsah_html <> ''
      ON CONFLICT (klic) DO UPDATE SET obsah_html = pi_body.obsah_html || EXCLUDED.obsah_html;
    DELETE FROM pi_body WHERE klic = '4.5';
    -- 4.6 adresa internetové stránky → 4.5 Adresa internetových stránek
    UPDATE pi_body SET klic = '4.5' WHERE klic = '4.6';
    -- 4.8 další elektronické adresy → připojit k 4.7 Elektronická adresa podatelny (vyhláška je tam řadí)
    INSERT INTO pi_body (klic, obsah_html, upraveno_at, upravil_id)
      SELECT '4.7', obsah_html, upraveno_at, upravil_id FROM pi_body WHERE klic = '4.8' AND obsah_html <> ''
      ON CONFLICT (klic) DO UPDATE SET obsah_html = pi_body.obsah_html || EXCLUDED.obsah_html;
    DELETE FROM pi_body WHERE klic = '4.8';
  `.execute(db);
  await sql`
    INSERT INTO nastaveni (klic, hodnota) VALUES (${ZNACKA_PI_515}, ${JSON.stringify({ at: new Date().toISOString() })}::jsonb)
      ON CONFLICT (klic) DO NOTHING`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await premapujPiBody(db);
  await sql`
    ALTER TABLE ud_kategorie ADD COLUMN archiv_verejny boolean NOT NULL DEFAULT true;
    UPDATE ud_kategorie SET archiv_verejny = false WHERE slug = 'jine-urady';
    INSERT INTO ud_kategorie (slug, nazev, min_dni, vychozi_dni, rozpocet, poradi) VALUES
      ('pozvanky-zo', 'Pozvánky na zasedání zastupitelstva', 7, 8, false, 2),
      ('poskytnute-informace', 'Poskytnuté informace (§ 5 odst. 3 zák. 106/1999 Sb.)', 2192, 2192, false, 8)
      ON CONFLICT (slug) DO NOTHING;

    CREATE INDEX IF NOT EXISTS ud_prilohy_soubor_idx ON ud_prilohy (soubor_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS ud_prilohy_soubor_idx;
    ALTER TABLE ud_kategorie DROP COLUMN IF EXISTS archiv_verejny;
  `.execute(db);
}
