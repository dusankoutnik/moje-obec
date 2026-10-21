import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import {
  CEZ_WEB,
  pocetMist,
  prevedOdpoved,
  souhrnMist,
  terminOdstavky,
  type ApiOdpoved,
} from '../src/moduly/odstavky/cez.js';
import { KLIC_NASTAVENI, OdstavkySluzba } from '../src/moduly/odstavky/sluzba.js';
import { obecZObjektu } from '../src/config/obec.js';
import { Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

// fixtura = skutečná odpověď API pro Vlastibořice (jen čísla domů a parcel, žádná jména) + vymyšlená zrušená
// odstávka se sousední obcí (adresy jiné obce se musí vynechat) a duplicita / položka bez začátku
const FIXTURA = JSON.parse(
  readFileSync(new URL('./fixtures/odstavky-cez.json', import.meta.url), 'utf8'),
) as ApiOdpoved;
const KOD = '564516';
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

function falesnyFetch(odpovedi: (() => Response)[]) {
  const volani: string[] = [];
  const f = (async (url: string | URL | Request) => {
    volani.push(String(url));
    const dalsi = odpovedi.shift();
    if (!dalsi) throw new Error('neočekávaný dotaz');
    return dalsi();
  }) as typeof fetch;
  return { f, volani };
}
const json =
  (data: unknown, status = 200, hlavicky: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', ...hlavicky },
    });

describe('převod odpovědi API ČEZ (bezstavy.cz)', () => {
  it('vybere odstávky obce, sloučí duplicity, vynechá položky bez začátku a adresy jiných obcí', () => {
    const o = prevedOdpoved(FIXTURA, KOD);
    expect(o.map((x) => x.id)).toEqual(['110061126700', '110061126633']); // podle začátku
    const listopad = o[1]!;
    expect(listopad.od.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(listopad.pdf).toBe('https://cdn.bezstavy.cz/pdf/301317712-db8tncdct0gcmo4g6k60.pdf');
    expect(listopad.casti[0]!.ulice[0]!.cislaPopisna).toHaveLength(12);
    expect(listopad.parcely).toEqual([{ katastr: 'Vlastibořice', parcely: ['177/2', '181/3'] }]);
    const zrusena = o[0]!;
    expect(zrusena.zruseno?.toISOString()).toBe('2026-07-10T09:12:00.000Z');
    expect(zrusena.casti.map((c) => c.nazev)).toEqual(['Sedlíšťka']); // Sousedov vynechán
  });

  it('odkaz na PDF jen jako relativní klíč na cdn.bezstavy.cz', () => {
    const o = prevedOdpoved(
      {
        outages_in_town: [
          { id: 1, opened_at: '2026-11-01T08:00:00Z', announcement_key: 'https://zly.example/x.pdf' },
          { id: 2, opened_at: '2026-11-01T08:00:00Z', announcement_key: '../x.pdf' },
        ],
      },
      KOD,
    );
    expect(o.map((x) => x.pdf)).toEqual([null, null]);
  });

  it('stručný souhrn míst a počet odběrných míst', () => {
    const o = prevedOdpoved(FIXTURA, KOD)[1]!;
    expect(souhrnMist(o)).toBe(
      'Vlastibořice: č. p. 1, 2, 3, 11, 13, 30, 32, 36 a dalších 4; č. ev. 6 · 2 pozemky',
    );
    expect(pocetMist(o)).toBe(15);
  });
});

describe('termíny v pražském čase', () => {
  it('zimní čas (UTC+1), letní čas (UTC+2), přes půlnoc a bez konce', () => {
    expect(terminOdstavky(new Date('2026-11-06T08:00:00Z'), new Date('2026-11-06T14:30:00Z'))).toBe(
      'pátek 6. 11. 2026, 9:00–15:30',
    );
    expect(terminOdstavky(new Date('2026-07-14T05:30:00Z'), new Date('2026-07-14T12:00:00Z'))).toBe(
      'úterý 14. 7. 2026, 7:30–14:00',
    );
    // 25. 10. 2026 končí letní čas: 23:00Z = 0:00 26. 10. (SEČ), začátek 21:00Z = 23:00 (SELČ)
    expect(terminOdstavky(new Date('2026-10-24T21:00:00Z'), new Date('2026-10-25T03:00:00Z'))).toBe(
      'sobota 24. 10. 2026 23:00 – neděle 25. 10. 2026 4:00',
    );
    expect(terminOdstavky(new Date('2026-11-06T08:00:00Z'), null)).toBe('od pátek 6. 11. 2026, 9:00');
  });
});

describe('profil obce', () => {
  it('kód obce jen číslice, odkaz ČEZ jen https', () => {
    const zaklad = { obec: { nazev: 'Obec X', kratky_nazev: 'X', casti: ['X'] } };
    expect(() => obecZObjektu({ ...zaklad, odstavky: { cez: { kod_obce: '56a' } } })).toThrow();
    expect(() => obecZObjektu({ ...zaklad, odstavky: { cez: { odkaz: 'http://x.cz' } } })).toThrow();
    const o = obecZObjektu(zaklad);
    expect(o.moduly.odstavky).toBe(false);
    expect(o.odstavky.cez).toEqual({ kod_obce: '', odkaz: '' });
  });
});

describe('služba: keš, 429, poslední známá data, historie', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t?.zavri());
  beforeEach(async () => {
    await t.db.deleteFrom('nastaveni').where('klic', '=', KLIC_NASTAVENI).execute();
  });

  const nova = (fetchFn: typeof fetch, ted: { d: Date }) =>
    new OdstavkySluzba(
      t.db,
      { kodObce: KOD, odkazCez: CEZ_WEB, userAgent: 'test' },
      log,
      fetchFn,
      () => ted.d,
    );

  it('stahuje nejvýš jednou za hodinu; po 429 drží data a čeká 3 h; chyba zdroje data nesmaže', async () => {
    const ted = { d: new Date('2026-10-21T10:00:00Z') };
    const { f, volani } = falesnyFetch([
      json(FIXTURA),
      json({ chyba: 'moc' }, 429),
      json({ x: 1 }, 500),
      json({ neco: 'jineho' }),
    ]);
    const s = nova(f, ted);
    await s.obnov();
    expect(volani).toEqual(['https://api.bezstavy.cz/cezd/api/inspecttown/564516']);
    let st = await s.stav();
    expect(st.aktualni.map((o) => o.id)).toEqual(['110061126633']);
    expect(st.posledniUspech?.toISOString()).toBe('2026-10-21T10:00:00.000Z');

    ted.d = new Date('2026-10-21T10:30:00Z');
    await s.obnov(); // keš — žádný dotaz
    expect(volani).toHaveLength(1);

    ted.d = new Date('2026-10-21T11:05:00Z');
    await s.obnov(); // 429
    expect(volani).toHaveLength(2);
    st = await s.stav();
    expect(st.chyba).toContain('429');
    expect(st.aktualni).toHaveLength(1); // poslední známá data zůstala

    ted.d = new Date('2026-10-21T13:00:00Z');
    await s.obnov(); // pauza po 429 ještě trvá
    expect(volani).toHaveLength(2);

    ted.d = new Date('2026-10-21T14:10:00Z');
    await s.obnov(); // HTTP 500
    expect(volani).toHaveLength(3);
    ted.d = new Date('2026-10-21T15:15:00Z');
    await s.obnov(); // nečekaný tvar odpovědi
    expect(volani).toHaveLength(4);
    st = await s.stav();
    expect(st.chyba).toContain('neočekávaný');
    expect(st.aktualni).toHaveLength(1);
    expect(st.posledniUspech?.toISOString()).toBe('2026-10-21T10:00:00.000Z');

    // data přežijí restart (nová instance čte z tabulky nastaveni)
    const s2 = nova(falesnyFetch([]).f, ted);
    expect((await s2.stav()).aktualni.map((o) => o.id)).toEqual(['110061126633']);
  });

  it('probíhající odstávka, zrušená v historii, proběhlé po 30 dnech mizí', async () => {
    const ted = { d: new Date('2026-07-12T08:00:00Z') };
    const s = nova(falesnyFetch([json(FIXTURA), json({ outages_in_town: [] })]).f, ted);
    await s.obnov();
    let st = await s.stav();
    expect(st.aktualni.map((o) => [o.id, !!o.zruseno])).toEqual([
      ['110061126700', true],
      ['110061126633', false],
    ]);

    ted.d = new Date('2026-11-06T09:00:00Z'); // během listopadové odstávky
    st = await s.stav();
    expect(st.aktualni[0]).toMatchObject({ id: '110061126633', probiha: true });

    ted.d = new Date('2026-11-07T09:00:00Z'); // proběhla; API už ji neposílá → zůstane v historii
    await s.obnov();
    st = await s.stav();
    expect(st.aktualni).toEqual([]);
    expect(st.historie.map((o) => o.id)).toEqual(['110061126633']);

    ted.d = new Date('2026-12-07T09:00:00Z');
    expect((await s.stav()).historie).toEqual([]);
  });
});

describe('titulka a stránka /odstavky', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t?.zavri());

  it('s odstávkou: karta na titulce s termínem, místy, PDF a webem ČEZ — bez obrázků a skriptů z cizích domén', async () => {
    const s = t.app.odstavky!;
    s.hodiny = () => new Date('2026-10-21T10:00:00Z');
    s.fetchFn = falesnyFetch([json(FIXTURA)]).f;
    await s.obnov(true);
    const p = new Prohlizec(t.base);
    const { text } = await p.get('/');
    expect(text).toContain('Plánované odstávky elektřiny');
    expect(text).toContain('<time datetime="2026-11-06T08:00:00.000Z">pátek 6. 11. 2026, 9:00–15:30</time>');
    expect(text).toContain('Všechna odběrná místa (15)');
    expect(text).toContain('href="https://cdn.bezstavy.cz/pdf/301317712-db8tncdct0gcmo4g6k60.pdf"');
    expect(text).toContain(`href="${CEZ_WEB}"`);
    expect(text).not.toContain('110061126700'); // zrušená červencová už proběhla
    // karta je před aktualitami (na mobilu nad nimi)
    expect(text.indexOf('h-odstavky')).toBeLessThan(text.indexOf('h-aktuality'));
    // nic se nenačítá z cizích serverů
    expect(text).not.toMatch(/<(img|script|iframe)[^>]+(src)="https?:\/\/(?!127\.0\.0\.1)/);

    const stranka = await p.get('/odstavky');
    expect(stranka.res.status).toBe(200);
    expect(stranka.text).toContain('<h1>Plánované odstávky elektřiny</h1>');
    expect(stranka.text).toContain('Posledních 30 dní');
    expect(stranka.text).toContain('Údaje ČEZ Distribuce ověřeny 21. 10. 2026 12:00.');
  });

  it('bez odstávek: na titulce nic, stránka /odstavky to řekne', async () => {
    const s = t.app.odstavky!;
    s.hodiny = () => new Date('2026-10-21T12:00:00Z');
    s.fetchFn = falesnyFetch([json({ outages: null, outages_in_town: [] })]).f;
    await s.obnov(true);
    const p = new Prohlizec(t.base);
    expect((await p.get('/')).text).not.toContain('h-odstavky');
    expect((await p.get('/odstavky')).text).toContain('Žádné plánované odstávky elektřiny.');
  });
});
