// Ochrana jednorázových kódů (code review 19. 10. 2026): atomické pokusy při souběžném hádání, jednorázové
// použití, limity podle účelu, prodleva, povolené předvolby, denní rozpočet SMS; klíč IP limitu po /64.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { vytvorDb, type Db } from '../src/db/index.js';
import { migruj } from '../src/db/migrate.js';
import { OtpSluzba, OTP_MAX_POKUSU, rozeberPredvolby } from '../src/lib/otp.js';
import { klicIp } from '../src/lib/limit.js';
import { jeTestovaciDb, TEST_DB_URL, vycistiDb } from './pomocnici.js';

let db: Db;
beforeAll(async () => {
  db = vytvorDb(TEST_DB_URL, 10);
  await vycistiDb(db);
  await migruj(db);
});
afterAll(async () => db.destroy());

describe('ověření kódu při souběhu', () => {
  it('20 souběžných špatných pokusů spotřebuje nejvýš 5 pokusů; pak neprojde ani správný kód', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const { kod } = (await otp.vydej('+420777100001', 'prihlaseni')) as { kod: string };
    const spatny = kod === '000000' ? '111111' : '000000';
    const vysledky = await Promise.all(
      Array.from({ length: 20 }, () => otp.over('+420777100001', 'prihlaseni', spatny)),
    );
    expect(vysledky.every((v) => v === false)).toBe(true);
    const r = await db
      .selectFrom('otp_kody')
      .select('pokusy')
      .where('kontakt', '=', '+420777100001')
      .executeTakeFirstOrThrow();
    expect(r.pokusy).toBe(OTP_MAX_POKUSU);
    expect(await otp.over('+420777100001', 'prihlaseni', kod)).toBe(false);
  });

  it('správný kód poslaný souběžně projde jen jednou', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const { kod } = (await otp.vydej('+420777100002', 'prihlaseni')) as { kod: string };
    const vysledky = await Promise.all(
      Array.from({ length: 5 }, () => otp.over('+420777100002', 'prihlaseni', kod)),
    );
    expect(vysledky.filter(Boolean)).toHaveLength(1);
  });

  it('platí jen nejnovější kód', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const { kod: stary } = (await otp.vydej('+420777100003', 'odber')) as { kod: string };
    const { kod: novy } = (await otp.vydej('+420777100003', 'odber')) as { kod: string };
    if (stary !== novy) expect(await otp.over('+420777100003', 'odber', stary)).toBe(false);
    expect(await otp.over('+420777100003', 'odber', novy)).toBe(true);
  });
});

describe('vydávání kódů', () => {
  it('limit 3/h platí pro každý účel zvlášť (útočník nevyčerpá oběti jiný účel)', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    for (let i = 0; i < 3; i++) expect('kod' in (await otp.vydej('+420777100010', 'prihlaseni'))).toBe(true);
    expect(await otp.vydej('+420777100010', 'prihlaseni')).toEqual({ chyba: 'limit' });
    expect('kod' in (await otp.vydej('+420777100010', 'zmena'))).toBe(true);
  });

  it('prodleva 60 s mezi kódy na stejné číslo', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi');
    expect('kod' in (await otp.vydej('+420777100020', 'prihlaseni'))).toBe(true);
    expect(await otp.vydej('+420777100020', 'odber')).toEqual({ chyba: 'cooldown' });
    expect('kod' in (await otp.vydej('+420777100021', 'prihlaseni'))).toBe(true);
    await sql`UPDATE otp_kody SET vytvoren_at = now() - interval '61 seconds' WHERE kontakt = '+420777100020'`.execute(
      db,
    );
    expect('kod' in (await otp.vydej('+420777100020', 'odber'))).toBe(true);
  });

  it('jen povolené předvolby; e-mail vždy', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    expect(await otp.vydej('+882123456789', 'prihlaseni')).toEqual({ chyba: 'predvolba' });
    expect('kod' in (await otp.vydej('+421901234567', 'prihlaseni'))).toBe(true);
    expect('kod' in (await otp.vydej('nekdo@example.cz', 'email'))).toBe(true);
    expect(rozeberPredvolby(' +420, 00421 ,x, +1')).toEqual(['+420', '+421', '+1']);
    const vse = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0, predvolby: [] });
    expect('kod' in (await vse.vydej('+882123456780', 'prihlaseni'))).toBe(true);
  });

  it('denní rozpočet SMS: po vyčerpání žádné kódy SMSkou a jedno upozornění', async () => {
    await sql`DELETE FROM otp_kody`.execute(db);
    const upozorneni: number[] = [];
    const otp = new OtpSluzba(db, 'tajemstvi', {
      cooldownS: 0,
      denniRozpocetSms: 2,
      priVycerpaniRozpoctu: (n) => void upozorneni.push(n),
    });
    expect('kod' in (await otp.vydej('+420777100030', 'prihlaseni'))).toBe(true);
    expect('kod' in (await otp.vydej('+420777100031', 'prihlaseni'))).toBe(true);
    expect(await otp.vydej('+420777100032', 'prihlaseni')).toEqual({ chyba: 'rozpocet' });
    expect(await otp.vydej('+420777100033', 'prihlaseni')).toEqual({ chyba: 'rozpocet' });
    expect('kod' in (await otp.vydej('jiny@example.cz', 'email'))).toBe(true); // e-mail rozpočet nečerpá
    expect(upozorneni).toEqual([2]);
  });

  it('souběžné žádosti o kód na stejné číslo neobejdou limit', async () => {
    const otp = new OtpSluzba(db, 'tajemstvi', { cooldownS: 0 });
    const v = await Promise.all(Array.from({ length: 10 }, () => otp.vydej('+420777100040', 'prihlaseni')));
    expect(v.filter((x) => 'kod' in x)).toHaveLength(3);
  });
});

describe('IP limity', () => {
  it('IPv6 se počítá po síti /64, IPv4 namapovaná do IPv6 jako IPv4', () => {
    expect(klicIp('2001:db8:1:2:aaaa::1')).toBe(klicIp('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(klicIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(klicIp('2001:db8:1:3::1')).not.toBe(klicIp('2001:db8:1:2::1'));
    expect(klicIp('2001:DB8:0001:0002:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(klicIp('::1')).toBe('0:0:0:0::/64');
    expect(klicIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(klicIp('203.0.113.5')).toBe('203.0.113.5');
    expect(klicIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
});

describe('testovací databáze', () => {
  it('testy odmítnou smazat databázi, jejíž název nekončí na _test', async () => {
    expect(jeTestovaciDb('postgres://u:p@db:5432/platforma_test')).toBe(true);
    expect(jeTestovaciDb('postgres://u:p@db:5432/platforma')).toBe(false);
    expect(jeTestovaciDb('postgres://u:p@db:5432/platforma_test_kopie')).toBe(false);
    expect(jeTestovaciDb('nesmysl')).toBe(false);
    await expect(vycistiDb(db, 'postgres://u:p@db:5432/platforma')).rejects.toThrow(/_test/);
    // nic se nesmazalo
    expect(
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM otp_kody`.execute(db)).rows[0]!.n,
    ).toBeGreaterThan(0);
  });
});
