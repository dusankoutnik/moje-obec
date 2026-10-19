// Barevná schémata: všechny barvy v sRGB gamutu a kontrast všech dvojic, které se na webu potkávají, ≥ 4,5 : 1
// (WCAG 2.1 AA) — počítáno, ne odhadnuto. Včetně nejhoršího případu textu přes úplně bílou fotku.
import { describe, expect, it } from 'vitest';
import { oklchNaHex, vGamutu } from '../src/lib/oklch.js';
import { cssSchematu, overSchema, SCHEMATA } from '../src/moduly/web/schemata.js';

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
});
