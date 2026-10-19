// Demo data pro vývoj a první instalaci: admin účet + ukázkoví odběratelé infokanálu. Idempotentní.
// Použití: npm run seed -- [+420telefon admina]   (výchozí +420777000001)
// Admin se přihlásí SMS kódem na zadané číslo (ve vývoji s OTP_DEV_ZOBRAZIT=1 je kód vidět na stránce).
import { nactiEnv } from '../config/env.js';
import { vytvorDb, pockejNaDb } from '../db/index.js';
import { migruj } from '../db/migrate.js';
import { normalizujTelefon } from '../lib/kontakty.js';
import { nahodnyToken } from '../lib/krypto.js';

const env = nactiEnv();
const db = vytvorDb(env.DATABASE_URL, 2);
await pockejNaDb(db);
await migruj(db);

const telefon = normalizujTelefon(process.argv[2] ?? '+420777000001');
if (!telefon) throw new Error('Neplatný telefon admina');

const admin = await db
  .insertInto('uzivatele')
  .values({
    telefon,
    email: null,
    heslo_hash: null,
    jmeno: 'Demo',
    prijmeni: 'Správce',
    prezdivka: 'Správce',
    role: ['admin'],
    gdpr_souhlas_at: new Date(),
    telefon_overen_at: new Date(),
  })
  .onConflict((oc) => oc.column('telefon').doUpdateSet({ role: ['admin'] }))
  .returning(['id', 'telefon'])
  .executeTakeFirstOrThrow();
console.log(`admin: ${admin.telefon} (${admin.id})`);

const demo = [
  {
    jmeno: 'Jana Nováková',
    telefon: '+420777000101',
    email: 'jana.novakova@example.cz',
    cast_obce: 'Vlastibořice',
    kanal: 'smisene',
  },
  { jmeno: 'Petr Svoboda', telefon: '+420777000102', email: null, cast_obce: 'Jivina', kanal: 'sms' },
  {
    jmeno: 'Marie Dvořáková',
    telefon: '+420777000103',
    email: 'marie.dvorakova@example.cz',
    cast_obce: 'Sedlíšťka',
    kanal: 'email',
  },
  { jmeno: 'Josef Černý', telefon: '+420777000104', email: null, cast_obce: 'Slavíkov', kanal: 'sms' },
] as const;
for (const d of demo) {
  await db
    .insertInto('ik_odberatele')
    .values({ ...d, token: nahodnyToken(16), overen_at: new Date(), souhlas_at: new Date(), zdroj: 'import' })
    .onConflict((oc) => oc.column('telefon').doNothing())
    .execute();
}
console.log(`demo odběratelé: ${demo.length}`);
await db.destroy();
