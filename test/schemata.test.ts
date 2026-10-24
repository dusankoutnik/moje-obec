// Barevná schémata: všechny barvy v sRGB gamutu a kontrast všech dvojic, které se na webu potkávají, ≥ 4,5 : 1
// (WCAG 2.1 AA) — počítáno, ne odhadnuto. Včetně nejhoršího případu textu přes úplně bílou fotku.
import { describe, expect, it } from 'vitest';
import { hexNaSrgb, oklchNaHex, srgbNaOklch, vGamutu } from '../src/lib/oklch.js';
import {
  cssSchematu,
  overSchema,
  pruhlednostiSchematu,
  SCHEMATA,
  vlastniSchema,
  type Pruhlednosti,
  type VlastniBarvy,
} from '../src/moduly/web/schemata.js';

describe('barevná schémata', () => {
  it('jsou aspoň 6 a mají unikátní id', () => {
    expect(SCHEMATA.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SCHEMATA.map((s) => s.id)).size).toBe(SCHEMATA.length);
  });
  it('OKLCH → hex odpovídá známým hodnotám', () => {
    expect(oklchNaHex([1, 0, 0])).toBe('#ffffff');
    expect(oklchNaHex([0, 0, 0])).toBe('#000000');
    expect(oklchNaHex([0.628, 0.2577, 29.23])).toBe('#ff0000');
  });
  for (const s of SCHEMATA) {
    it(`${s.nazev}: barvy v gamutu sRGB a kontrast AA`, () => {
      for (const k of ['primarni', 'naTmave', 'akcent', 'aktivni', 'tmava', 'svetla'] as const)
        expect(vGamutu(s[k]), `${s.id}.${k} mimo sRGB`).toBe(true);
      for (const d of overSchema(s))
        expect(d.kontrast, `${s.id}: ${d.nazev} = ${d.kontrast.toFixed(2)}`).toBeGreaterThanOrEqual(d.min);
    });
  }
  it('CSS má hex zálohu i OKLCH', () => {
    const css = cssSchematu(SCHEMATA[0]!);
    expect(css).toMatch(/--primarni:#[0-9a-f]{6}/);
    expect(css).toContain('@supports (color: oklch(0 0 0))');
    expect(css).toContain('color-mix(in oklch');
  });
});

describe('šablony', () => {
  it('žádný blok kódu nezačíná „[“ nebo „(“ bez středníku (Eta ho připojí k předchozímu výrazu)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const chyby: string[] = [];
    const projdi = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) projdi(p);
        else if (p.endsWith('.eta'))
          readFileSync(p, 'utf8')
            .split('\n')
            .forEach((r, i) => {
              if (/<%\s+[[(]/.test(r)) chyby.push(`${p}:${i + 1}`);
            });
      }
    };
    projdi('views');
    expect(chyby).toEqual([]);
  });

  it('ztmavení fotky 0–80 %: sklo a podklad textu se dopočítají tak, aby kontrast vždy prošel', () => {
    for (const sch of SCHEMATA)
      for (let z = 0; z <= 0.8001; z += 0.05) {
        const p = pruhlednostiSchematu(sch, z);
        for (const d of overSchema(sch, p))
          expect(d.kontrast, `${sch.id} závoj ${z.toFixed(2)}: ${d.nazev}`).toBeGreaterThanOrEqual(d.min);
        // nejmenší možné: o setinu průhlednější sklo už neprojde (pokud není na spodní hranici 0,3)
        if (p.sklo > 0.3) {
          const slabsi: Pruhlednosti = { ...p, sklo: Math.round((p.sklo - 0.01) * 100) / 100 };
          expect(
            overSchema(sch, slabsi).some((d) => d.kontrast < d.min),
            `${sch.id} ${z}: sklo není nejmenší`,
          ).toBe(true);
        }
      }
  });
  it('světlejší fotka = hustší sklo', () => {
    const sch = SCHEMATA[0]!;
    expect(pruhlednostiSchematu(sch, 0.1).sklo).toBeGreaterThanOrEqual(pruhlednostiSchematu(sch, 0.6).sklo);
    expect(cssSchematu(sch, ':root', pruhlednostiSchematu(sch, 0.2))).toMatch(
      /--gradient-hore:rgba\([^)]*, 0\.2\)/,
    );
  });
});

describe('vlastní barevné schéma', () => {
  it('OKLCH ↔ sRGB tam a zpět', () => {
    for (const hex of ['#2e7d32', '#ffd600', '#151a16', '#c2410c', '#1e40af']) {
      expect(oklchNaHex(srgbNaOklch(hexNaSrgb(hex)))).toBe(hex);
    }
  });

  const pripady: [string, VlastniBarvy][] = [
    ['rozumné barvy', { primarni: '#1e5aa8', akcent: '#ffd23f', tmava: '#101828' }],
    ['všechno světlé', { primarni: '#a8e6ff', akcent: '#fff7d6', tmava: '#cfd8dc' }],
    ['všechno tmavé', { primarni: '#0b1d0b', akcent: '#2d2d00', tmava: '#000000' }],
    [
      'šedé + ruční role',
      { primarni: '#888888', akcent: '#777777', tmava: '#666666', na_tmave: '#555555', aktivni: '#999999' },
    ],
  ];
  for (const [nazev, barvy] of pripady)
    it(`${nazev}: po doladění projde kontrolou AA`, () => {
      const { schema } = vlastniSchema(barvy);
      const spatne = overSchema(schema).filter((d) => d.kontrast < d.min);
      expect(spatne.map((d) => `${d.nazev} ${d.kontrast.toFixed(2)}`)).toEqual([]);
    });

  it('rozumné barvy se neupravují (hlavní barva zůstane)', () => {
    const { upravy } = vlastniSchema({ primarni: '#1e5aa8', akcent: '#ffd23f', tmava: '#101828' });
    expect(upravy.filter((u) => u.role === 'primarni')).toEqual([]);
  });
});
