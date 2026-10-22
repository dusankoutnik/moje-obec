// Převod účtů z MůjÚčtu do platformy.
// Použití: npx tsx src/scripts/prevod-mujucet.ts <cesta k mujucet.db> [--nanecisto] [--anonymizovat]
//          [--sloucit-telefonem] [--redaktor-bez-webu]
// --nanecisto: celý převod proběhne v transakci, vypíše počty a vrátí se zpět. Výpis neobsahuje osobní údaje.
// Postup a kontroly: docs/PREVOD.md
import { DatabaseSync } from 'node:sqlite';
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { migruj } from '../db/migrate.js';
import { prevedUcty, type MujUcetRadek } from '../moduly/ucty/prevod.js';

const args = process.argv.slice(2);
const cesta = args.find((a) => !a.startsWith('--'));
const prepinac = (p: string) => args.includes(p);
if (!cesta) {
  console.error('Použití: prevod-mujucet.ts <mujucet.db> [--nanecisto] [--anonymizovat] [--sloucit-telefonem]');
  process.exit(2);
}

const zdroj = new DatabaseSync(cesta, { readOnly: true });
const radky = zdroj.prepare('SELECT * FROM users ORDER BY id').all() as unknown as MujUcetRadek[];
zdroj.close();

const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2, { statementTimeoutMs: 0 });
await pockejNaDb(db);
await migruj(db);

const NANECISTO = new Error('nanečisto');
let vysledek: Awaited<ReturnType<typeof prevedUcty>> | null = null;
try {
  if (prepinac('--nanecisto')) {
    // převod běží v naší transakci (prevedUcty ji pozná přes isTransaction) a na konci ji vyhozením chyby zrušíme
    await db.transaction().execute(async (tx) => {
      vysledek = await prevedUcty(tx, radky, volby());
      throw NANECISTO;
    });
  } else {
    vysledek = await prevedUcty(db, radky, volby());
  }
} catch (e) {
  if (e !== NANECISTO) throw e;
}
await db.destroy();

function volby() {
  return {
    anonymizovat: prepinac('--anonymizovat'),
    sloucitTelefonem: prepinac('--sloucit-telefonem'),
    redaktorWebDeska: !prepinac('--redaktor-bez-webu'),
  };
}

const v = vysledek!;
console.log(prepinac('--nanecisto') ? '— NANEČISTO (nic se neuložilo) —' : '— převod uložen —');
console.log(JSON.stringify({ ...v, konflikty: v.konflikty.length }, null, 2));
for (const k of v.konflikty) console.log(`konflikt: účet č. ${k.cislo}: ${k.duvod}`);
