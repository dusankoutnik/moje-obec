import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prevedPolozky } from '../src/moduly/web/akce-externi.js';
import { prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

const ted = new Date('2026-10-20T08:00:00Z');
const polozky = [
  {
    id: 'r1',
    typ: 'rezervace',
    serie: 's7',
    zdroj_nazev: 'Sál Kulturního domu',
    datum: '2026-10-22',
    od: '18:30',
    do: '19:30',
    cely_den: false,
    nazev: 'Jóga',
  },
  {
    id: 'r2',
    typ: 'rezervace',
    serie: 's7',
    zdroj_nazev: 'Sál Kulturního domu',
    datum: '2026-10-29',
    od: '18:30',
    do: '19:30',
    cely_den: false,
    nazev: 'Jóga',
  },
  {
    id: 'r3',
    typ: 'rezervace',
    serie: null,
    zdroj_nazev: 'Sál Kulturního domu',
    datum: '2026-11-06',
    od: null,
    do: null,
    cely_den: true,
    nazev: 'Podzimní divadelní víkend',
  },
  {
    id: 'r4',
    typ: 'rezervace',
    serie: null,
    zdroj_nazev: 'Hřiště KOŠE',
    datum: '2026-10-19',
    od: '18:00',
    do: '21:00',
    cely_den: false,
    nazev: 'Včerejší turnaj',
  },
  {
    id: 'e1',
    typ: 'predprodej',
    serie: null,
    zdroj_nazev: 'Kulturní dům',
    datum: '2026-12-31',
    od: '20:00',
    do: null,
    cely_den: false,
    nazev: 'Silvestr',
    odkaz: 'https://rezervace.example/predprodej/silvestr',
  },
];

describe('akce z rezervací', () => {
  it('série se sloučí do jedné položky s nejbližším termínem, proběhlé zmizí, čas je pražský', () => {
    const a = prevedPolozky(polozky, ted);
    expect(a.map((x) => x.titulek)).toEqual(['Jóga', 'Podzimní divadelní víkend', 'Silvestr']);
    expect(a[0]!.opakovani).toBe('každý čtvrtek 18:30–19:30, nejbližší ve čtvrtek');
    expect(a[0]!.datum.toISOString()).toBe('2026-10-22T16:30:00.000Z'); // letní čas
    expect(a[2]!.datum.toISOString()).toBe('2026-12-31T19:00:00.000Z'); // zimní čas
    expect(a[2]!.url).toContain('/predprodej/silvestr');
    expect(a[1]!.url).toBeNull();
  });
});

describe('stránka Akce s akcemi z rezervací', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
    t.app.web.kalendar.akce = async () => prevedPolozky(polozky, ted);
  });
  afterAll(async () => t.zavri());

  it('ukáže akce sálu i předprodeje, sérii jednou, bez odkazu tam, kde detail není', async () => {
    const r = await new Prohlizec(t.base).get('/akce');
    expect(r.text.match(/Jóga/g)?.length).toBe(1);
    expect(r.text).toContain('každý čtvrtek 18:30–19:30');
    expect(r.text).toContain('Podzimní divadelní víkend');
    expect(r.text).toContain('href="https://rezervace.example/predprodej/silvestr"');
    expect(r.text).not.toContain('href="/akce/null"');
    expect(r.text).not.toContain('Včerejší turnaj');
    const uvod = await new Prohlizec(t.base).get('/');
    expect(uvod.text).toContain('Jóga');
  });

  it('ve správě akcí je vidět i přehled akcí z rezervací (jen ke čtení)', async () => {
    const p = await prihlasSRoli(t, '777 555 101', ['web']);
    const r = await p.get('/sprava/web/akce');
    expect(r.text).toContain('Z rezervačního systému');
    expect(r.text).toContain('každý čtvrtek 18:30–19:30');
    expect(r.text).toContain('Podzimní divadelní víkend');
  });
});

describe('perex na detailu', () => {
  it('perex, který jen opakuje začátek článku, se nezobrazí; vlastní perex ano', async () => {
    const { perexOpakujeText } = await import('../src/lib/html.js');
    const html =
      '<p>Do Obecního zastupitelstva byli zvoleni:</p><p>1. Nováková Jana 133</p><p>2. Svoboda Petr 126</p>';
    expect(
      perexOpakujeText(
        'Do Obecního zastupitelstva byli zvoleni: 1. Nováková Jana 133 2. Svoboda Petr 126 […]',
        html,
      ),
    ).toBe(true);
    expect(perexOpakujeText('Výsledky letošních voleb a poděkování voličům.', html)).toBe(false);
    expect(perexOpakujeText('', html)).toBe(true);
  });
});
