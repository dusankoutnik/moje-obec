import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { vytvorDb, type Db } from '../src/db/index.js';
import { migruj } from '../src/db/migrate.js';
import { OtpSluzba, OTP_MAX_POKUSU } from '../src/lib/otp.js';
import { TEST_DB_URL, vycistiDb } from './pomocnici.js';
import { hashujHeslo, overHeslo } from '../src/lib/krypto.js';

let db: Db;
beforeAll(async () => {
  db = vytvorDb(TEST_DB_URL, 2);
  await vycistiDb(db);
  await migruj(db);
});
afterAll(async () => db.destroy());

describe('OTP kódy', () => {
  it('vydá, ověří jednou, hashuje', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const v = await otp.vydej('+420777000001', 'prihlaseni');
    expect('kod' in v && v.kod).toMatch(/^\d{6}$/);
    const kod = (v as { kod: string }).kod;
    const radek = await db.selectFrom('otp_kody').selectAll().executeTakeFirstOrThrow();
    expect(radek.kod_hash).not.toContain(kod);
    expect(await otp.over('+420777000001', 'odber', kod)).toBe(false); // jiný účel
    expect(await otp.over('+420777000001', 'prihlaseni', kod)).toBe(true);
    expect(await otp.over('+420777000001', 'prihlaseni', kod)).toBe(false); // už použitý
  });
  it('limit 3 za hodinu a max pokusů', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const kody: string[] = [];
    for (let i = 0; i < 3; i++)
      kody.push(((await otp.vydej('+420777000002', 'prihlaseni')) as { kod: string }).kod);
    expect(await otp.vydej('+420777000002', 'prihlaseni')).toEqual({ chyba: 'limit' });
    for (let i = 0; i < OTP_MAX_POKUSU; i++)
      expect(await otp.over('+420777000002', 'prihlaseni', '000000')).toBe(false);
    // po vyčerpání pokusů neprojde ani správný kód
    expect(await otp.over('+420777000002', 'prihlaseni', kody[2]!)).toBe(false);
  });
  it('prošlý kód neplatí', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const { kod } = (await otp.vydej('+420777000003', 'prihlaseni')) as { kod: string };
    await sql`UPDATE otp_kody SET expires_at = now() - interval '1 minute' WHERE kontakt = '+420777000003'`.execute(
      db,
    );
    expect(await otp.over('+420777000003', 'prihlaseni', kod)).toBe(false);
  });
});

describe('hesla', () => {
  it('scrypt hash a ověření', async () => {
    const h = await hashujHeslo('velmi-tajne');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await overHeslo('velmi-tajne', h)).toBe(true);
    expect(await overHeslo('jine', h)).toBe(false);
    expect(await overHeslo('x', null)).toBe(false);
  });
});
