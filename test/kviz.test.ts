// Kvíz: výběr otázek (bez DB), import balíků, hra anonymně i s účtem, skóre, reset, správa a přístupnost šablon.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importujBaliky, overBalik, poradiKategorie } from '../src/moduly/kviz/import.js';
import { navrhObtiznosti, skoreZ } from '../src/moduly/kviz/sluzba.js';
import {
  cilovaObtiznost,
  posunPoKole,
  vyberOtazku,
  zamichej,
  type Kandidat,
} from '../src/moduly/kviz/vyber.js';
import { adresareBaliku } from '../src/moduly/kviz/index.js';
import { csrfZ, prihlasSRoli, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

// deterministická „náhoda“ pro testy výběru
function nahodaZ(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const k = (id: string, kategorie: string, obtiznost: number, extra: Partial<Kandidat> = {}): Kandidat => ({
  id,
  kategorie,
  obtiznost,
  videna: 0,
  posledniSpravne: null,
  posledniAt: null,
  ...extra,
});

describe('výběr otázek (bez DB)', () => {
  it('cílová obtížnost podle profilu kola, posun ±1, nikdy těžký začátek', () => {
    expect([...Array(10).keys()].map((i) => cilovaObtiznost(i, 0))).toEqual([1, 1, 2, 2, 2, 3, 3, 4, 4, 5]);
    expect(cilovaObtiznost(0, 1)).toBe(2);
    expect(cilovaObtiznost(1, 1)).toBe(2);
    expect(cilovaObtiznost(2, 1)).toBe(3);
    expect(cilovaObtiznost(9, 1)).toBe(5);
    expect(cilovaObtiznost(0, -1)).toBe(1);
    expect(cilovaObtiznost(9, -1)).toBe(4);
    expect(cilovaObtiznost(5, 7)).toBe(4); // posun se omezí na ±1
  });

  it('posun po kole podle úspěšnosti', () => {
    expect(posunPoKole(8, 10)).toBe(1);
    expect(posunPoKole(7, 10)).toBe(0);
    expect(posunPoKole(5, 10)).toBe(0);
    expect(posunPoKole(4, 10)).toBe(-1);
    expect(posunPoKole(0, 0)).toBe(0);
  });

  it('přednost: neviděné → špatně zodpovězené → správně zodpovězené', () => {
    const t = Date.now();
    const kandidati = [
      k('spravne', 'a', 1, { videna: 1, posledniSpravne: true, posledniAt: t }),
      k('spatne', 'a', 1, { videna: 2, posledniSpravne: false, posledniAt: t }),
      k('nove', 'a', 1),
    ];
    expect(vyberOtazku(kandidati, { krok: 0, posun: 0 })!.id).toBe('nove');
    expect(vyberOtazku(kandidati.slice(0, 2), { krok: 0, posun: 0 })!.id).toBe('spatne');
    expect(vyberOtazku(kandidati.slice(0, 1), { krok: 0, posun: 0 })!.id).toBe('spravne');
  });

  it('drží cílovou obtížnost a na začátku kola nedá těžkou otázku', () => {
    const kandidati = [1, 2, 3, 4, 5].flatMap((o) => [k(`a${o}`, 'a', o), k(`b${o}`, 'b', o)]);
    for (let seed = 1; seed < 30; seed++) {
      const n = nahodaZ(seed);
      expect(vyberOtazku(kandidati, { krok: 0, posun: 1 }, n)!.obtiznost).toBe(2);
      expect(vyberOtazku(kandidati, { krok: 9, posun: 0 }, n)!.obtiznost).toBe(5);
      expect(vyberOtazku(kandidati, { krok: 5, posun: -1 }, n)!.obtiznost).toBe(2);
    }
    // v bance jsou jen těžké otázky → i tak se něco vybere (nejlehčí dostupná)
    expect(vyberOtazku([k('x', 'a', 5), k('y', 'a', 4)], { krok: 0, posun: 0 })!.id).toBe('y');
  });

  it('kategorie se nestřídají dvakrát za sebou, pokud je výběr', () => {
    const kandidati = [k('a1', 'a', 1), k('a2', 'a', 1), k('b1', 'b', 1)];
    for (let seed = 1; seed < 20; seed++)
      expect(vyberOtazku(kandidati, { krok: 0, posun: 0, posledniKategorie: 'a' }, nahodaZ(seed))!.id).toBe(
        'b1',
      );
    // jediná kategorie → opakuje se
    expect(vyberOtazku([k('a1', 'a', 1)], { krok: 0, posun: 0, posledniKategorie: 'a' })!.id).toBe('a1');
  });

  it('nevrací otázky z tohoto kola ani právě zobrazenou, dokud je z čeho brát', () => {
    const kandidati = [k('x', 'a', 1), k('y', 'a', 1), k('z', 'a', 1)];
    expect(
      vyberOtazku(kandidati, { krok: 2, posun: 0, vynechat: new Set(['x', 'y']), aktualni: 'z' })!.id,
    ).not.toBe('z');
    expect(vyberOtazku(kandidati, { krok: 0, posun: 0, vynechat: new Set(['x', 'y']) })!.id).toBe('z');
    expect(vyberOtazku([k('x', 'a', 1)], { krok: 0, posun: 0, aktualni: 'x' })!.id).toBe('x');
    expect(vyberOtazku([], { krok: 0, posun: 0 })).toBeNull();
  });

  it('ze správně zodpovězených bere ty nejdéle neviděné', () => {
    const kandidati = [...Array(12).keys()].map((i) =>
      k(`q${i}`, 'a', 1, { videna: 1, posledniSpravne: true, posledniAt: 1000 + i }),
    );
    for (let seed = 1; seed < 30; seed++) {
      const id = vyberOtazku(kandidati, { krok: 0, posun: 0 }, nahodaZ(seed))!.id;
      expect(['q0', 'q1', 'q2']).toContain(id);
    }
  });

  it('zamíchání je permutace a mění pořadí', () => {
    const videne = new Set<string>();
    for (let seed = 1; seed < 40; seed++) {
      const p = zamichej(4, nahodaZ(seed));
      expect([...p].sort()).toEqual([0, 1, 2, 3]);
      videne.add(p.join(''));
    }
    expect(videne.size).toBeGreaterThan(5);
  });

  it('skóre, návrh obtížnosti a pořadí kategorií', () => {
    expect(skoreZ(0, 0)).toEqual({ spravne: 0, spatne: 0, procento: null });
    expect(skoreZ(2, 1)).toEqual({ spravne: 2, spatne: 1, procento: 67 });
    expect(navrhObtiznosti(9, 9)).toBeNull();
    expect(navrhObtiznosti(10, 9)).toBe(1);
    expect(navrhObtiznosti(10, 5)).toBe(3);
    expect(navrhObtiznosti(10, 1)).toBe(5);
    expect(poradiKategorie('obec')).toBeLessThan(poradiKategorie('cr'));
    expect(poradiKategorie('cestina')).toBeLessThan(poradiKategorie('neco-jineho'));
  });

  it('adresáře balíků: veřejné + balíky obce z env', () => {
    const a = adresareBaliku({ KVIZ_VEREJNE: '/x', KVIZ_BALIKY: '/a, /b' });
    expect(a).toEqual([
      { cesta: '/x', stitek: 'verejne' },
      { cesta: '/a', stitek: 'obec' },
      { cesta: '/b', stitek: 'obec2' },
    ]);
    expect(adresareBaliku({ KVIZ_BALIKY: '' })[0]!.cesta).toMatch(/kviz-otazky$/);
  });
});

describe('ověření balíku (zod)', () => {
  const zaklad = (o: Record<string, unknown> = {}) =>
    [
      'kategorie: cr',
      'nazev: Česko',
      'otazky:',
      '  - id: t-1',
      '    otazka: Hlavní město?',
      `    odpovedi: ${JSON.stringify(o.odpovedi ?? ['Praha', 'Brno', 'Ostrava', 'Plzeň'])}`,
      `    obtiznost: ${o.obtiznost ?? 1}`,
      '    vysvetleni: Protože.',
    ].join('\n');

  it('platný balík (čísla v odpovědích se převedou na text)', () => {
    const r = overBalik(zaklad({ odpovedi: [1918, 1945, 1968, 1989] }));
    expect('balik' in r && r.balik.otazky[0]!.odpovedi).toEqual(['1918', '1945', '1968', '1989']);
    expect('balik' in r && r.balik.otazky[0]!.zdroj).toBe('');
  });

  it('chyby: počet odpovědí, opakování, obtížnost, YAML, prázdný balík', () => {
    expect(overBalik(zaklad({ odpovedi: ['a', 'b', 'c'] }))).toMatchObject({
      chyba: expect.stringContaining('právě 4 odpovědi'),
    });
    expect(overBalik(zaklad({ odpovedi: ['Praha', 'praha', 'x', 'y'] }))).toMatchObject({
      chyba: expect.stringContaining('opakují'),
    });
    expect(overBalik(zaklad({ obtiznost: 6 }))).toMatchObject({
      chyba: expect.stringContaining('obtížnost'),
    });
    expect(overBalik('kategorie: [')).toMatchObject({ chyba: expect.stringContaining('YAML') });
    expect(overBalik('kategorie: cr\nnazev: X\notazky: []')).toMatchObject({
      chyba: expect.stringContaining('žádné otázky'),
    });
    expect(overBalik('kategorie: Česko\nnazev: X\notazky: []')).toMatchObject({
      chyba: expect.stringContaining('kategorie'),
    });
  });
});

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

/** z HTML otázky vytáhne tlačítka odpovědí: pozice + text */
function tlacitka(html: string) {
  return [
    ...html.matchAll(
      /<button class="kviz-odpoved" type="submit" name="odpoved" value="(\d)"[^>]*>.*?<span class="kviz-odpoved-text">([^<]*)<\/span><\/button>/g,
    ),
  ].map((m) => ({ pozice: m[1]!, text: m[2]! }));
}
const idOtazky = (html: string) => /name="otazka" value="([^"]+)"/.exec(html)![1]!;

async function odpovez(p: Prohlizec, spravne: boolean) {
  const o = await p.get('/kviz/otazka');
  const b = tlacitka(o.text);
  expect(b).toHaveLength(4);
  const volba = b.find((x) => x.text.startsWith('Správně') === spravne)!;
  const r = await p.post('/kviz/odpoved', {
    _csrf: csrfZ(o.text),
    otazka: idOtazky(o.text),
    odpoved: volba.pozice,
  });
  return {
    otazka: o,
    vysledek: r,
    id: idOtazky(o.text),
    poziceSpravne: b.find((x) => x.text.startsWith('Správně'))!.pozice,
  };
}
async function dalsi(p: Prohlizec, html: string) {
  return p.post('/kviz/dalsi', { _csrf: csrfZ(html) });
}
async function zacni(p: Prohlizec, kategorie?: string[]) {
  const uvod = await p.get('/kviz');
  return p.post('/kviz/start', { _csrf: csrfZ(uvod.text), ...(kategorie ? { kategorie } : {}) });
}
async function hracZ(p: Prohlizec) {
  const c = (p as unknown as { cookies: Map<string, string> }).cookies.get('mo_kviz');
  return t.db.selectFrom('kviz_hraci').selectAll().where('id', '=', c!).executeTakeFirstOrThrow();
}

describe('import balíků', () => {
  it('při startu naimportuje testovací balík v pevném pořadí kategorií', async () => {
    const kat = await t.app.kviz.kategorie();
    expect(kat.map((x) => x.slug)).toEqual(['obec', 'cr', 'svet', 'vlastni-temata']);
    expect(kat.reduce((s, x) => s + x.pocet, 0)).toBe(27);
    const znovu = await t.app.kvizImport();
    expect(znovu).toMatchObject({ otazky: 27, nove: 0, zmenene: 0, deaktivovane: 0, chyby: [] });
  });

  it('změny se propíší, odstraněné otázky se jen deaktivují, chybný soubor nic nevyřadí', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kviz-'));
    try {
      const balik = (otazky: string[]) =>
        `kategorie: zkouska\nnazev: Zkouška\nikona: "🧪"\notazky:\n` +
        otazky
          .map(
            (o) =>
              `  - id: zk-${o}\n    otazka: "Otázka ${o} <b>tučně</b>?"\n    odpovedi: [ano${o}, ne${o}, možná${o}, nevím${o}]\n    obtiznost: 1\n    vysvetleni: ""\n    zdroj: ""`,
          )
          .join('\n');
      await writeFile(path.join(dir, 'zkouska.yml'), balik(['1', '2']));
      const adr = [{ cesta: dir, stitek: 'test' }];
      const r1 = await importujBaliky(t.db, adr);
      expect(r1).toMatchObject({ soubory: 1, otazky: 2, nove: 2, chyby: [] });
      // ostatní (testovací balík z repozitáře) v tomto běhu nebyly → mimo balík
      expect(r1.deaktivovane).toBe(27);
      await t.db
        .insertInto('kviz_hraci')
        .values({ id: '00000000-0000-4000-8000-000000000001', otazka_id: null, poradi: null })
        .execute();
      await t.db
        .insertInto('kviz_odpovedi')
        .values({
          hrac_id: '00000000-0000-4000-8000-000000000001',
          otazka_id: 'zk-2',
          zvolena: 0,
          spravne: true,
        })
        .execute();

      await writeFile(path.join(dir, 'zkouska.yml'), balik(['1']).replace('Otázka 1', 'Otázka jedna'));
      const r2 = await importujBaliky(t.db, adr);
      expect(r2).toMatchObject({ nove: 0, zmenene: 1, deaktivovane: 1 });
      const zk2 = await t.db
        .selectFrom('kviz_otazky')
        .selectAll()
        .where('id', '=', 'zk-2')
        .executeTakeFirstOrThrow();
      expect(zk2.v_baliku).toBe(false);
      expect(
        await t.db.selectFrom('kviz_odpovedi').select('id').where('otazka_id', '=', 'zk-2').execute(),
      ).toHaveLength(1); // historie zůstala

      // chybný soubor: přeskočí se, jeho otázky zůstávají aktivní
      await writeFile(
        path.join(dir, 'zkouska.yml'),
        'kategorie: zkouska\nnazev: Zkouška\notazky:\n  - id: zk-1\n    otazka: X?\n    odpovedi: [a, b]\n    obtiznost: 1',
      );
      await writeFile(path.join(dir, 'dalsi.yml'), balik(['3']).replace(/zkouska/, 'dalsi'));
      const r3 = await importujBaliky(t.db, adr);
      expect(r3.chyby).toHaveLength(1);
      expect(r3.chyby[0]!.soubor).toBe('test/zkouska.yml');
      const zk1 = await t.db
        .selectFrom('kviz_otazky')
        .selectAll()
        .where('id', '=', 'zk-1')
        .executeTakeFirstOrThrow();
      expect(zk1.v_baliku).toBe(true);
      expect(zk1.otazka).toBe('Otázka jedna <b>tučně</b>?');

      // stejné id ve dvou souborech = chyba druhého souboru
      await writeFile(path.join(dir, 'zkouska.yml'), balik(['3']));
      const r4 = await importujBaliky(t.db, adr);
      expect(r4.chyby.map((c) => c.zprava).join()).toMatch(/zk-3 se opakuje/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await t.db.deleteFrom('kviz_odpovedi').execute();
      await t.db.deleteFrom('kviz_hraci').execute();
      await t.app.kvizImport();
    }
    // po návratu na testovací balík jsou otázky zkoušky mimo balík a nenabízejí se
    const kat = await t.app.kviz.kategorie();
    expect(kat.map((x) => x.slug)).toEqual(['obec', 'cr', 'svet', 'vlastni-temata']);
  });
});

describe('hra (anonymní hráč)', () => {
  it('úvod bez cookie; cookie mo_kviz vznikne až kliknutím Začít kvíz', async () => {
    const r = await fetch(t.base + '/kviz', { headers: { accept: 'text/html' } });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie().join()).not.toMatch(/mo_kviz/);
    expect(html).toContain('<legend>Ze kterých oblastí chcete otázky?</legend>');
    expect(html).toMatch(/name="kategorie" value="obec"[^>]*checked/);
    expect(html).toContain('cookie mo_kviz');

    const p = new Prohlizec(t.base);
    const uvod = await p.get('/kviz');
    const res = await fetch(t.base + '/kviz/start', {
      method: 'POST',
      headers: {
        cookie: (uvod.res.headers.getSetCookie()[0] ?? '').split(';')[0]!,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _csrf: csrfZ(uvod.text) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/kviz/otazka');
    const c = res.headers.getSetCookie().find((x) => x.startsWith('mo_kviz='))!;
    expect(c).toMatch(/Path=\/kviz/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
  });

  it('bez CSRF tokenu se nehraje', async () => {
    const p = new Prohlizec(t.base);
    const r = await p.post('/kviz/start', {}, false);
    expect(r.res.status).toBe(403);
  });

  it('otázka: oblast, skóre, fieldset s legendou, 4 odpovědi; výsledek s vysvětlením a zdrojem', async () => {
    const p = new Prohlizec(t.base);
    const o = await zacni(p);
    expect(o.url).toMatch(/\/kviz\/otazka$/);
    expect(o.text).toContain('<span class="vh">Oblast: </span>');
    expect(o.text).toMatch(/<fieldset>\s*<legend><h1 class="kviz-text-otazky"/);
    expect(o.text).toContain('Průběžné skóre');
    expect(o.text).toContain('zatím bez odpovědi');
    expect(o.text).toContain('href="/kviz/skore"');
    expect(o.text).toContain('action="/kviz/reset"');
    expect(o.text).toContain('/static/js/kviz.js');
    expect(tlacitka(o.text).map((b) => b.pozice)).toEqual(['0', '1', '2', '3']);

    const prvni = await odpovez(p, true);
    expect(prvni.vysledek.url).toMatch(/\/kviz\/vysledek$/);
    expect(prvni.vysledek.text).toMatch(
      /role="status" aria-live="polite">\s*<h1[^>]*><span aria-hidden="true">✓<\/span> Správně!/,
    );
    expect(prvni.vysledek.text).toContain(`Vysvětlení k otázce ${prvni.id}.`);
    expect(prvni.vysledek.text).toMatch(
      /Zdroj: (<a href="https:\/\/example.org\/zdroj" rel="noopener noreferrer">|Učebnice testování)/,
    );
    expect(prvni.vysledek.text).toContain('<strong>100 %</strong> <span>(1 správně / 0 špatně)</span>');

    // reload výsledku nic nemění, opakované odeslání odpovědi se nepočítá
    const znovu = await p.post('/kviz/odpoved', {
      _csrf: csrfZ(prvni.vysledek.text),
      otazka: prvni.id,
      odpoved: '0',
    });
    expect(znovu.url).toMatch(/\/kviz\/vysledek$/);
    expect(znovu.text).toContain('(1 správně / 0 špatně)');
    // na otázku se z výsledku nedá vrátit (přesměruje zpět na výsledek)
    expect((await p.get('/kviz/otazka')).url).toMatch(/\/kviz\/vysledek$/);

    await dalsi(p, prvni.vysledek.text);
    const druha = await odpovez(p, false);
    expect(druha.id).not.toBe(prvni.id);
    expect(druha.vysledek.text).toContain('Špatně');
    const spravna = await t.db
      .selectFrom('kviz_otazky')
      .select('odpovedi')
      .where('id', '=', druha.id)
      .executeTakeFirstOrThrow();
    expect(druha.vysledek.text).toContain(`Správná odpověď: ${spravna.odpovedi[0]}`);
    expect(druha.vysledek.text).toContain('✗ vaše odpověď');
    expect(druha.vysledek.text).toContain('✓ správná odpověď');
    expect(druha.vysledek.text).toContain('<strong>50 %</strong> <span>(1 správně / 1 špatně)</span>');

    // odpověď na jinou než rozehranou otázku se nezapočítá
    await dalsi(p, druha.vysledek.text);
    const o3 = await p.get('/kviz/otazka');
    const spatna = await p.post('/kviz/odpoved', { _csrf: csrfZ(o3.text), otazka: prvni.id, odpoved: '0' });
    expect(spatna.url).toMatch(/\/kviz\/otazka$/);
    const n = await t.db
      .selectFrom('kviz_odpovedi')
      .select('id')
      .where('hrac_id', '=', (await hracZ(p)).id)
      .execute();
    expect(n).toHaveLength(2);
  });

  it('kolo po 10 otázkách: začíná lehkými, kategorie se střídají, po dobrém kole je další těžší', async () => {
    const p = new Prohlizec(t.base);
    await zacni(p);
    const obtiznosti: number[] = [];
    const kategorie: string[] = [];
    const pozice = new Set<string>();
    let posledni = '';
    for (let i = 0; i < 10; i++) {
      const h = await hracZ(p);
      const o = await t.db
        .selectFrom('kviz_otazky as o')
        .innerJoin('kviz_kategorie as k', 'k.id', 'o.kategorie_id')
        .select(['o.obtiznost', 'k.slug'])
        .where('o.id', '=', h.otazka_id!)
        .executeTakeFirstOrThrow();
      obtiznosti.push(o.obtiznost);
      kategorie.push(o.slug);
      const r = await odpovez(p, true);
      pozice.add(r.poziceSpravne);
      posledni = r.vysledek.text;
      if (i < 9) await dalsi(p, r.vysledek.text);
    }
    expect(obtiznosti[0]).toBeLessThanOrEqual(2);
    expect(obtiznosti[1]).toBeLessThanOrEqual(2);
    expect(Math.max(...obtiznosti.slice(0, 2))).toBeLessThan(Math.max(...obtiznosti.slice(7)));
    for (let i = 1; i < kategorie.length; i++) expect(kategorie[i]).not.toBe(kategorie[i - 1]);
    expect(pozice.size).toBeGreaterThan(1); // správná odpověď není vždy na stejném místě
    expect(
      new Set(
        (
          await t.db
            .selectFrom('kviz_odpovedi')
            .select('otazka_id')
            .where('hrac_id', '=', (await hracZ(p)).id)
            .execute()
        ).map((x) => x.otazka_id),
      ).size,
    ).toBe(10);
    expect(posledni).toContain('Konec 1. kola: 10 z 10 správně.');
    expect(posledni).toContain('další kolo bude o něco těžší');

    await dalsi(p, posledni);
    const h = await hracZ(p);
    expect(h).toMatchObject({ kolo: 2, krok: 0, posun: 1 });
    const o = await t.db
      .selectFrom('kviz_otazky')
      .select('obtiznost')
      .where('id', '=', h.otazka_id!)
      .executeTakeFirstOrThrow();
    expect(o.obtiznost).toBeLessThanOrEqual(2);
    const stranka = await p.get('/kviz/otazka');
    expect(stranka.text).toContain('Otázka 1 z 10 · kolo 2');
  });

  it('jen zvolené kategorie; rozehraný kvíz jde z úvodu dokončit', async () => {
    const p = new Prohlizec(t.base);
    await zacni(p, ['svet']);
    for (let i = 0; i < 4; i++) {
      const r = await odpovez(p, i % 2 === 0);
      expect(r.id).toMatch(/^svet-/);
      await dalsi(p, r.vysledek.text);
    }
    const uvod = await p.get('/kviz');
    expect(uvod.text).toContain('href="/kviz/otazka"');
    expect(uvod.text).toMatch(/value="svet" [^>]*checked/);
    expect(uvod.text).not.toMatch(/value="cr" [^>]*checked/);
    expect(uvod.text).toContain('Začít nové kolo');
    // neznámé kategorie se zahodí; když nic nezbude, hraje se ze všech
    await zacni(p, ['neexistuje']);
    expect((await hracZ(p)).kategorie).toEqual([]);
  });

  it('reset skóre s potvrzením a skóre po oblastech (celkem i od resetu)', async () => {
    const p = new Prohlizec(t.base);
    await zacni(p, ['cr']);
    let r = await odpovez(p, true);
    await dalsi(p, r.vysledek.text);
    r = await odpovez(p, false);

    const potvrzeni = await p.get('/kviz/reset');
    expect(potvrzeni.text).toContain('Resetovat skóre?');
    expect(potvrzeni.text).toContain('50 % (1 správně / 1 špatně)');
    const po = await p.post('/kviz/reset', { _csrf: csrfZ(potvrzeni.text) });
    expect(po.text).toContain('Skóre je vynulované');
    expect(po.url).toMatch(/\/kviz\/vysledek$/); // rozehraná otázka už byla zodpovězená
    expect(po.text).toContain('zatím bez odpovědi');

    await dalsi(p, po.text);
    await odpovez(p, true);
    const s = await p.get('/kviz/skore');
    expect(s.text).toContain('Skóre po oblastech');
    expect(s.text).toContain('Poslední reset:');
    // Česko: celkem 2 správně / 1 špatně, od resetu 1 / 0
    expect(s.text).toMatch(
      /Česko<\/th><td>2<\/td><td>1<\/td><td>67 %<\/td><td>1<\/td><td>0<\/td><td>100 %<\/td>/,
    );
    expect(s.text).toMatch(/Svět<\/th><td>0<\/td><td>0<\/td><td>—<\/td>/);
    expect(s.text).toMatch(/scope="colgroup" colspan="3">Celkem/);
  });

  it('bez hráče přesměruje na úvod; neplatná cookie se smaže', async () => {
    const p = new Prohlizec(t.base);
    for (const u of ['/kviz/otazka', '/kviz/vysledek', '/kviz/skore', '/kviz/reset'])
      expect((await p.get(u)).url).toMatch(/\/kviz$/);
    const r = await fetch(t.base + '/kviz', { headers: { cookie: 'mo_kviz=nesmysl' } });
    expect(r.headers.getSetCookie().join()).toMatch(/mo_kviz=;.*Expires=Thu, 01 Jan 1970/);
  });

  it('vypnuté otázky ve všech kategoriích → stránka s návratem na úvod', async () => {
    const p = new Prohlizec(t.base);
    await zacni(p, ['vlastni-temata']);
    await t.db
      .updateTable('kviz_otazky')
      .set({ vypnuta_at: new Date() })
      .where('id', 'like', 'vlastni-temata-%')
      .execute();
    try {
      const h = await hracZ(p);
      await t.db
        .updateTable('kviz_hraci')
        .set({ otazka_id: null, poradi: null })
        .where('id', '=', h.id)
        .execute();
      const o = await p.get('/kviz/otazka');
      expect(o.text).toContain('Ve vybraných oblastech teď není žádná otázka');
    } finally {
      await t.db
        .updateTable('kviz_otazky')
        .set({ vypnuta_at: null })
        .where('id', 'like', 'vlastni-temata-%')
        .execute();
    }
  });
});

describe('hra s účtem', () => {
  it('anonymní skóre se po přihlášení připojí k účtu (účet ještě nehrál)', async () => {
    const p = new Prohlizec(t.base);
    await zacni(p, ['obec']);
    const r = await odpovez(p, true);
    await dalsi(p, r.vysledek.text);
    const anon = await hracZ(p);
    await prihlasTelefonem(p, '777888001');
    const uvod = await p.get('/kviz');
    expect(uvod.text).toContain('Skóre se ukládá k vašemu účtu');
    expect(uvod.text).toContain('<strong>100 %</strong>');
    const u = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777888001')
      .executeTakeFirstOrThrow();
    const h = await t.db
      .selectFrom('kviz_hraci')
      .selectAll()
      .where('uzivatel_id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(h.id).toBe(anon.id);
    expect((p as unknown as { cookies: Map<string, string> }).cookies.has('mo_kviz')).toBe(false);
    // rozehraná otázka pokračuje
    expect((await p.get('/kviz/otazka')).text).toContain(`value="${h.otazka_id}"`);
  });

  it('účet s vlastním skóre: anonymní odpovědi se přičtou, anonymní hráč zmizí', async () => {
    const ucet = await prihlasSRoli(t, '777888002', []);
    await zacni(ucet, ['cr']);
    let r = await odpovez(ucet, true);
    await dalsi(ucet, r.vysledek.text);

    const p = new Prohlizec(t.base);
    await zacni(p, ['svet']);
    r = await odpovez(p, false);
    const anon = await hracZ(p);
    await prihlasTelefonem(p, '777888002');
    const s = await p.get('/kviz/skore');
    expect(s.text).toMatch(/Česko<\/th><td>1<\/td><td>0<\/td>/);
    expect(s.text).toMatch(/Svět<\/th><td>0<\/td><td>1<\/td>/);
    expect(
      await t.db.selectFrom('kviz_hraci').select('id').where('id', '=', anon.id).executeTakeFirst(),
    ).toBeUndefined();
    // přihlášený nový hráč nedostane cookie
    const novy = await prihlasSRoli(t, '777888003', []);
    const uvod = await novy.get('/kviz');
    const res = await fetch(t.base + '/kviz/start', {
      method: 'POST',
      headers: {
        cookie: [...(novy as unknown as { cookies: Map<string, string> }).cookies]
          .map(([a, b]) => `${a}=${b}`)
          .join('; '),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _csrf: csrfZ(uvod.text) }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().join()).not.toMatch(/mo_kviz=/);
  });
});

describe('správa kvízu', () => {
  it('občan nemá přístup, role kviz i web ano; dlaždice ve správě', async () => {
    const obcan = await prihlasSRoli(t, '777888010', []);
    expect((await obcan.get('/sprava/kviz')).res.status).toBe(403);
    const web = await prihlasSRoli(t, '777888011', ['web']);
    expect((await web.get('/sprava/kviz')).res.status).toBe(200);
    const kviz = await prihlasSRoli(t, '777888012', ['kviz']);
    const sprava = await kviz.get('/sprava');
    expect(sprava.text).toContain('href="/sprava/kviz"');
    const prehled = await kviz.get('/sprava/kviz');
    expect(prehled.text).toContain('href="/sprava/kviz/cr"');
    expect(prehled.text).toMatch(/Poslední načtení .*27 otázek/);
    expect((await kviz.get('/sprava/kviz/neexistuje')).res.status).toBe(404);
  });

  it('úspěšnost napoprvé, vypnutí a zapnutí otázky (audit, hráčům se nenabízí)', async () => {
    const kviz = await prihlasSRoli(t, '777888012', ['kviz']);
    const d = await kviz.get('/sprava/kviz/obec');
    expect(d.text).toContain('obec-001');
    expect(d.text).toContain('Správně napoprvé');
    const vypnuti = await kviz.post('/sprava/kviz/otazka/obec-001', {
      _csrf: csrfZ(d.text),
      akce: 'vypnout',
    });
    expect(vypnuti.url).toMatch(/\/sprava\/kviz\/obec/);
    expect(vypnuti.text).toContain('Otázka obec-001 je vypnutá');
    expect(vypnuti.text).toMatch(/id="o-obec-001" class="blokovan"/);
    const kat = await t.app.kviz.kategorie();
    expect(kat.find((x) => x.slug === 'obec')!.pocet).toBe(5);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', '=', 'kviz.otazka_vypnuta')
      .execute();
    expect(audit).toHaveLength(1);
    // vypnutá otázka se při výběru neobjeví
    const p = new Prohlizec(t.base);
    await zacni(p, ['obec']);
    for (let i = 0; i < 6; i++) {
      const r = await odpovez(p, true);
      expect(r.id).not.toBe('obec-001');
      await dalsi(p, r.vysledek.text);
    }
    const zpet = await kviz.post('/sprava/kviz/otazka/obec-001', {
      _csrf: csrfZ(vypnuti.text),
      akce: 'zapnout',
    });
    expect(zpet.text).toContain('Otázka obec-001 je znovu zapnutá');
    expect(
      (await kviz.post('/sprava/kviz/otazka/neni', { _csrf: csrfZ(zpet.text), akce: 'vypnout' }, false)).res
        .status,
    ).toBe(404);
  });

  it('ruční načtení balíků (audit)', async () => {
    const kviz = await prihlasSRoli(t, '777888012', ['kviz']);
    const d = await kviz.get('/sprava/kviz');
    const r = await kviz.post('/sprava/kviz/import', { _csrf: csrfZ(d.text) });
    expect(r.text).toContain('Balíky načteny: 27 otázek');
    expect(
      await t.db.selectFrom('audit_log').select('id').where('akce', '=', 'kviz.import').execute(),
    ).toHaveLength(1);
  });

  it('role kviz jde přidělit ve správě uživatelů', async () => {
    const admin = await prihlasSRoli(t, '777888020', ['admin']);
    const u = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777888010')
      .executeTakeFirstOrThrow();
    const d = await admin.get(`/sprava/uzivatele/${u.id}`);
    expect(d.text).toContain('value="kviz"');
  });
});
