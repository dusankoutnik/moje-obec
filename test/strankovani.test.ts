import { describe, expect, it } from 'vitest';
import { cislaStran, strankovani } from '../src/lib/strankovani.js';

describe('stránkování', () => {
  it('čísla stran s výpustkou', () => {
    expect(cislaStran(1, 1)).toEqual([1]);
    expect(cislaStran(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(cislaStran(1, 20)).toEqual([1, 2, 3, null, 20]);
    expect(cislaStran(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
    // mezera jedné strany se doplní číslem, ne výpustkou
    expect(cislaStran(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, null, 20]);
    expect(cislaStran(20, 20)).toEqual([1, null, 18, 19, 20]);
  });

  it('odkazy zachovají filtr a počet na stránce, výchozí hodnoty vynechají', () => {
    const s = strankovani({
      cesta: '/aktuality',
      parametry: { kategorie: 'knihovna' },
      strana: 3,
      stran: 10,
      celkem: 115,
      na: 24,
      moznosti: [12, 24, 48],
    });
    expect(s.prvni).toBe('/aktuality?kategorie=knihovna&na=24');
    expect(s.predchozi).toBe('/aktuality?kategorie=knihovna&na=24&strana=2');
    expect(s.posledni).toBe('/aktuality?kategorie=knihovna&na=24&strana=10');
    const v = strankovani({
      cesta: '/aktuality',
      parametry: {},
      strana: 1,
      stran: 1,
      celkem: 3,
      na: 12,
      moznosti: [12, 24],
    });
    expect(v.prvni).toBeNull();
    expect(v.dalsi).toBeNull();
    expect(v.polozky).toEqual([{ strana: 1, href: '/aktuality', aktualni: true }]);
  });
});
