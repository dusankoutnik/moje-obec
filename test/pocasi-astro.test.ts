import { describe, expect, it } from 'vitest';
import { astro, fazeZCisla } from '../src/moduly/pocasi/astro.js';

const praha = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague',
  hour: 'numeric',
  minute: '2-digit',
});

describe('Slunce a Měsíc', () => {
  it('Vlastibořice 23. 10. 2026: Slunce vychází kolem 7:36 a zapadá kolem 17:54 (ještě letní čas)', () => {
    const a = astro(new Date('2026-10-23T10:00:00Z'), 50.6186, 15.0519);
    const [vh, vm] = praha.format(a.slunceVychod!).split(':').map(Number);
    const [zh] = praha.format(a.slunceZapad!).split(':').map(Number);
    expect(vh! * 60 + vm!).toBeGreaterThan(7 * 60 + 25);
    expect(vh! * 60 + vm!).toBeLessThan(7 * 60 + 45);
    expect(zh).toBe(17);
    expect(a.osvetleni).toBeGreaterThanOrEqual(0);
    expect(a.osvetleni).toBeLessThanOrEqual(100);
  });

  it('události Měsíce patří na dnešek v Praze', () => {
    const den = '2026-10-23';
    const a = astro(new Date(`${den}T10:00:00Z`), 50.6186, 15.0519);
    const d = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
    for (const x of [a.mesicVychod, a.mesicZapad]) if (x) expect(d.format(x)).toBe(den);
    expect(a.mesicVychod || a.mesicZapad).toBeTruthy();
  });

  it('fáze z čísla', () => {
    expect(fazeZCisla(0)).toBe('moon-new');
    expect(fazeZCisla(0.99)).toBe('moon-new');
    expect(fazeZCisla(0.25)).toBe('moon-first-quarter');
    expect(fazeZCisla(0.5)).toBe('moon-full');
    expect(fazeZCisla(0.75)).toBe('moon-last-quarter');
  });
});
