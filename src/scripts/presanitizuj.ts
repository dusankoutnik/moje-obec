// Po změně pravidel sanitizace (src/lib/html.ts) projde uložený obsah webu a povinných informací a znovu ho
// sanitizuje. Mění jen to, co se liší; vypíše počet. Bezpečné spustit opakovaně.
//   node dist/scripts/presanitizuj.js [--nasucho]
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { sanitizuj } from '../lib/html.js';

const nasucho = process.argv.includes('--nasucho');
const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2);
await pockejNaDb(db);
let zmen = 0;
for (const o of await db.selectFrom('web_obsah').select(['id', 'obsah_html']).execute()) {
  const novy = sanitizuj(o.obsah_html);
  if (novy !== o.obsah_html) {
    zmen++;
    if (!nasucho)
      await db.updateTable('web_obsah').set({ obsah_html: novy }).where('id', '=', o.id).execute();
  }
}
for (const b of await db.selectFrom('pi_body').select(['klic', 'obsah_html']).execute()) {
  const novy = sanitizuj(b.obsah_html);
  if (novy !== b.obsah_html) {
    zmen++;
    if (!nasucho)
      await db.updateTable('pi_body').set({ obsah_html: novy }).where('klic', '=', b.klic).execute();
  }
}
console.log(`${nasucho ? 'Změnilo by se' : 'Změněno'}: ${zmen}`);
await db.destroy();
