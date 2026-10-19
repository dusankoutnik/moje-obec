import { describe, expect, it } from 'vitest';
import { KonzoleSms } from '../src/lib/sms/konzole.js';
import { mapaPresmerovani, PresmerovaniSms, zobrazitDevKod } from '../src/lib/sms/presmerovani.js';

describe('přesměrování SMS (vývoj/pilot)', () => {
  const env = {
    SMS_PRESMEROVANI: '777 000 001>777000099, nesmysl>, +420777000002 > +420602111222',
    OTP_DEV_ZOBRAZIT: true,
  };

  it('mapa se normalizuje na E.164 a neplatné páry ignoruje', () => {
    expect([...mapaPresmerovani(env)]).toEqual([
      ['+420777000001', '+420777000099'],
      ['+420777000002', '+420602111222'],
    ]);
    expect(mapaPresmerovani({ SMS_PRESMEROVANI: undefined }).size).toBe(0);
  });

  it('přesměrované číslo jde skutečnou bránou na cílové číslo, ostatní základním poskytovatelem', async () => {
    const zaklad = new KonzoleSms();
    const skutecny = new KonzoleSms();
    const s = new PresmerovaniSms(zaklad, skutecny, mapaPresmerovani(env));
    const v = await s.posli('+420777000001', 'kod 123456');
    await s.posli('+420777999999', 'jiny');
    expect(skutecny.odeslane.map((x) => x.telefon)).toEqual(['+420777000099']);
    expect(zaklad.odeslane.map((x) => x.telefon)).toEqual(['+420777999999']);
    expect(v.branaId).toMatch(/^presm:/);
    expect(await s.stavDoruceni(v.branaId!)).toBe('doruceno');
  });

  it('kód přesměrovaného čísla se na stránce nikdy neukáže', () => {
    expect(zobrazitDevKod(env, '+420777000001')).toBe(false);
    expect(zobrazitDevKod(env, '777 000 001')).toBe(false);
    expect(zobrazitDevKod(env, '+420777999999')).toBe(true);
    expect(zobrazitDevKod({ ...env, OTP_DEV_ZOBRAZIT: false }, '+420777999999')).toBe(false);
  });
});
