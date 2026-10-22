// Převod VlastiKanálu do infokanálu platformy (odběratelé, kategorie, opt-outy, historie hlášení) — docs/PREVOD.md.
//
//   node dist/scripts/prevod-vlastikanal.js /cesta/vlastikanal.db [--nanecisto] [--anonymizovat]
//   (ve vývoji: npx tsx src/scripts/prevod-vlastikanal.ts …)
//
//   --nanecisto     převod proběhne v transakci, která se vrátí — vypíše počty, nic nezapíše
//   --anonymizovat  vývojová kopie: jména, telefony a e-maily nahrazené (stejné id a vazby), bez poznámek
//   --doparovat     jen dopáruje vazby odběratel → účet podle čísla účtu MujÚčtu (po převodu účtů)
// Opakované spuštění je bezpečné (páruje podle id ve VlastiKanálu). Vypisuje jen počty, žádné osobní údaje.
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { migruj } from '../db/migrate.js';
import { doparujUcty, prevedVlastikanal } from '../moduly/infokanal/prevod.js';
import { nactiVlastikanal } from '../moduly/infokanal/prevod-sqlite.js';

const argv = process.argv.slice(2);
const volby = new Set(argv.filter((a) => a.startsWith('--')));
const cesta = argv.find((a) => !a.startsWith('--'));
if (!cesta && !volby.has('--doparovat')) {
  console.error('Použití: prevod-vlastikanal <vlastikanal.db> [--nanecisto] [--anonymizovat] | --doparovat');
  process.exit(2);
}
const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2, { statementTimeoutMs: 0 });
try {
  await pockejNaDb(db);
  await migruj(db);
  if (volby.has('--doparovat')) {
    console.log(JSON.stringify({ sparovano: await doparujUcty(db) }));
  } else {
    const data = nactiVlastikanal(cesta!);
    const v = await prevedVlastikanal(db, data, {
      nanecisto: volby.has('--nanecisto'),
      anonymizovat: volby.has('--anonymizovat'),
    });
    console.log(
      (volby.has('--nanecisto') ? 'NANEČISTO (nic nezapsáno): ' : 'Převedeno: ') + JSON.stringify(v, null, 2),
    );
  }
} finally {
  await db.destroy();
}
