// Doplnění textu stávajících souborů (po importu, po doinstalování nástrojů): JEN zařadí soubory do fronty,
// zpracování běží na pozadí v aplikaci (worker à 1 min). Postup sledujte ve Správa → Obecní web → Text dokumentů.
//
//   node dist/scripts/text-souboru.js --chybejici     soubory, které ve frontě ještě nebyly (výchozí, bezpečné)
//   node dist/scripts/text-souboru.js --vse           všechny indexovatelné soubory znovu (i ty, které text už mají)
//   node dist/scripts/text-souboru.js --jen-pdf       jen PDF (znovu)
//   node dist/scripts/text-souboru.js --znovu-chyby   jen stavy chyba, bez_textu, nepodporovano
//   node dist/scripts/text-souboru.js --id <uuid> [<uuid> …]   konkrétní soubory (přednostně)
//   (ve vývoji: npx tsx src/scripts/text-souboru.ts …)
import path from 'node:path';
import pino from 'pino';
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { migruj } from '../db/migrate.js';
import { SouboroveUloziste } from '../lib/soubory.js';
import { TextFronta, type RezimHromadnehoZarazeni } from '../lib/text-fronta.js';

const args = process.argv.slice(2);
const rezim: RezimHromadnehoZarazeni | 'id' = args.includes('--vse')
  ? 'vse'
  : args.includes('--jen-pdf')
    ? 'jen-pdf'
    : args.includes('--znovu-chyby')
      ? 'znovu-chyby'
      : args.includes('--id')
        ? 'id'
        : 'chybejici';
const ids = rezim === 'id' ? args.slice(args.indexOf('--id') + 1).filter((a) => !a.startsWith('--')) : [];
if (rezim === 'id' && !ids.length) {
  console.error('--id vyžaduje aspoň jedno id souboru');
  process.exit(2);
}

const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2);
await pockejNaDb(db);
await migruj(db);
const log = pino({ level: 'warn' });
const fronta = new TextFronta(
  db,
  new SouboroveUloziste(db, env.DATA_DIR),
  {
    zapnuto: true,
    ocrJazyky: env.OCR_JAZYKY,
    ocrMaxStran: env.OCR_MAX_STRAN,
    ocrDpi: env.OCR_DPI,
    maxZnaku: env.TEXT_MAX_ZNAKU,
    tmpDir: path.join(path.resolve(env.DATA_DIR), 'tmp'),
  },
  log,
);
fronta.vypniPlanovac();
const n = rezim === 'id' ? await fronta.zarad(ids, { prednostne: true }) : await fronta.zaradHromadne(rezim);
const prehled = await fronta.prehled();
console.log(`Zařazeno do fronty: ${n} (režim ${rezim}).`);
console.log(
  `Ve frontě celkem: ${prehled.ceka}, odhad zpracování ${Math.ceil(prehled.odhadS / 60)} min ` +
    `(průměr ${Math.round(prehled.prumerMs / 1000)} s na soubor). Zpracovává běžící aplikace (TEXT_SOUBORU=1).`,
);
if (!env.TEXT_SOUBORU) console.log('POZOR: TEXT_SOUBORU=0 — aplikace frontu nezpracovává.');
await db.destroy();
