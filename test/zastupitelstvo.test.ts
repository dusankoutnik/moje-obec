// Volební období zastupitelstva z profilu obce: bod 3 povinných informací (bez DB).
import { describe, expect, it } from 'vitest';
import { obecZObjektu } from '../src/config/obec.js';
import { vyplnPi, zastupitelstvoText } from '../src/moduly/deska/povinne.js';

const zaklad = {
  nazev: 'Obec Testov',
  kratky_nazev: 'Testov',
  casti: ['Testov'],
  lide: [{ skupina: 'Zastupitelstvo', funkce: 'Starosta', jmeno: 'Jan Vzorový' }],
};

describe('volební období zastupitelstva', () => {
  it('bez údajů se nic nevypíše', () => {
    expect(zastupitelstvoText(obecZObjektu({ obec: zaklad }))).toBe('');
  });

  it('období a poznámka (escapovaná) v bodě 3', () => {
    const o = obecZObjektu({
      obec: {
        ...zaklad,
        zastupitelstvo: { volebni_obdobi: '2026–2030', poznamka: 'Ustavující <zasedání>.' },
      },
    });
    expect(zastupitelstvoText(o)).toBe(
      '<p>Zastupitelstvo obce, volební období 2026–2030. Ustavující &lt;zasedání&gt;.</p>',
    );
    const bod3 = vyplnPi(o, new Map(), { baseUrl: 'https://x', deska: true }).find((b) => b.klic === '3')!;
    expect(bod3.html.startsWith('<p>Zastupitelstvo obce, volební období 2026–2030.')).toBe(true);
    expect(bod3.html).toContain('<li>Starosta: Jan Vzorový</li>');
  });
});
