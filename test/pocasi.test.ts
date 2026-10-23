// Modul počasí: převod odpovědi MET Norway na dny (místní půlnoc, změna času), keš podle Expires / 304,
// poslední známá data při výpadku, stará data bez dlaždice, výstraha ČHMÚ, umístění podle vzhledu, stránka /pocasi.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { denniSymbol, popisSymbolu, prevedMet, type MetOdpoved } from '../src/moduly/pocasi/met.js';
import { grafTeploty } from '../src/moduly/pocasi/index.js';
import { KLIC_NASTAVENI, PocasiSluzba } from '../src/moduly/pocasi/sluzba.js';
import { obecZObjektu } from '../src/config/obec.js';
import { csrfZ, postSoubory, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

// skutečná odpověď api.met.no pro Vlastibořice stažená 23. 10. 2026 12:56 UTC (první bod 12:00Z)
const FIXTURA = JSON.parse(
  readFileSync(new URL('./fixtures/met-compact.json', import.meta.url), 'utf8'),
) as MetOdpoved;
const TED = new Date('2026-10-23T12:30:00Z');
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

function falesnyFetch(odpovedi: (() => Response)[]) {
  const volani: { url: string; hlavicky: Record<string, string> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    volani.push({ url: String(url), hlavicky: (init?.headers ?? {}) as Record<string, string> });
    const dalsi = odpovedi.shift();
    if (!dalsi) throw new Error('neočekávaný dotaz');
    return dalsi();
  }) as typeof fetch;
  return { f, volani };
}
const odpoved =
  (data: unknown, status = 200, hlavicky: Record<string, string> = {}) =>
  () =>
    new Response(status === 304 ? null : JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', ...hlavicky },
    });
const hlavickyMet = (ted: Date) => ({
  expires: new Date(ted.getTime() + 30 * 60_000).toUTCString(),
  'last-modified': 'Fri, 23 Oct 2026 12:54:37 GMT',
});

describe('převod odpovědi MET', () => {
  it('dny podle místní půlnoci (i přes konec letního času), max/min, srážky, vítr', () => {
    const p = prevedMet(FIXTURA, TED);
    expect(p.dny.map((d) => d.datum)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
    ]);
    expect(p.dny.map((d) => [d.max, d.min, d.srazky, d.vitrMax])).toEqual([
      [12, 8, 0, 18],
      [10, 4, 0, 26],
      [8, 3, 10.5, 23], // 25. 10. má 25 hodin (konec letního času)
      [11, 3, 0.1, 18],
      [11, 5, 0.1, 11],
      [13, 6, 0.1, 17],
      [11, 3, 0.2, 16],
    ]);
    expect(p.dny[0]!.castecny).toBe(true);
    expect(p.dny[1]!.castecny).toBe(false);
    // denní symbol je vždy denní varianta s českým popisem
    for (const d of p.dny) {
      expect(d.symbol).not.toMatch(/_night$/);
      expect(d.popis).not.toBe('počasí bez popisu');
    }
  });

  it('hodinová data od aktuální hodiny, nejvýš 48 h; „teď“ = běžící hodina', () => {
    const p = prevedMet(FIXTURA, TED);
    expect(p.ted?.cas.toISOString()).toBe('2026-10-23T12:00:00.000Z');
    expect(p.ted?.teplota).toBe(11.8);
    expect(p.ted?.popis).toBe('zataženo');
    expect(p.hodiny).toHaveLength(48);
    expect(p.hodiny.at(-1)!.cas.toISOString()).toBe('2026-10-25T11:00:00.000Z');
    // o 2 h později začíná hodinová řada od 14:00Z
    expect(prevedMet(FIXTURA, new Date('2026-10-23T14:10:00Z')).hodiny[0]!.cas.toISOString()).toBe(
      '2026-10-23T14:00:00.000Z',
    );
    expect(p.modelZ?.toISOString()).toBe('2026-10-23T11:22:24.000Z');
  });

  it('české popisy všech symbolů, pro které máme ikonu', () => {
    const ikony = readdirSync(new URL('../public/img/pocasi/', import.meta.url)).filter((f) =>
      f.endsWith('.svg'),
    );
    expect(ikony.length).toBeGreaterThanOrEqual(83);
    for (const f of ikony) expect(popisSymbolu(f.replace('.svg', '')), f).not.toBe('počasí bez popisu');
    expect(popisSymbolu('heavyrainshowersandthunder_night')).toBe('silné dešťové přeháňky a bouřky');
    expect(popisSymbolu('lightssleetshowersandthunder_day')).toBe('slabé přeháňky deště se sněhem a bouřky');
    expect(popisSymbolu('partlycloudy_polartwilight')).toBe('polojasno');
    expect(denniSymbol('clearsky_night')).toBe('clearsky_day');
    expect(denniSymbol('cloudy')).toBe('cloudy');
  });

  it('graf: čára teploty, sloupce srážek, popisky času po 6 h', () => {
    const g = grafTeploty(prevedMet(FIXTURA, TED).hodiny)!;
    expect(g.cara.split(' ')).toHaveLength(48);
    expect(g.sloupce.length).toBeGreaterThan(0);
    expect(g.casy.some((c) => c.pulnoc && /sobota 24\. 10\./.test(c.text))).toBe(true);
    expect(grafTeploty([])).toBeNull();
  });
});

describe('profil obce', () => {
  it('modul je výchozí vypnutý, souřadnice v rozsahu', () => {
    const zaklad = { obec: { nazev: 'Obec X', kratky_nazev: 'X', casti: ['X'] } };
    const o = obecZObjektu(zaklad);
    expect(o.moduly.pocasi).toBe(false);
    expect(o.pocasi).toEqual({ lat: null, lon: null, nazev: '' });
    expect(() => obecZObjektu({ ...zaklad, pocasi: { lat: 91, lon: 15 } })).toThrow();
  });
});

describe('služba: Expires, 304, výpadek, stará data', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t?.zavri());
  beforeEach(async () => {
    await t.db.deleteFrom('nastaveni').where('klic', '=', KLIC_NASTAVENI).execute();
  });

  const nova = (fetchFn: typeof fetch, ted: { d: Date }) =>
    new PocasiSluzba(
      t.db,
      { lat: 50.61864, lon: 15.05186, nazev: 'Testov', userAgent: 'ObecniWebOdVoltu/2.0 https://test' },
      log,
      fetchFn,
      () => ted.d,
    );

  it('souřadnice na 4 místa a User-Agent; před Expires a do 30 min nic; potom If-Modified-Since a 304', async () => {
    const ted = { d: TED };
    const { f, volani } = falesnyFetch([
      odpoved(FIXTURA, 200, hlavickyMet(TED)),
      odpoved(null, 304, { expires: new Date(TED.getTime() + 90 * 60_000).toUTCString() }),
    ]);
    const s = nova(f, ted);
    await s.obnov();
    expect(volani[0]!.url).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=50.6186&lon=15.0519',
    );
    expect(volani[0]!.hlavicky['user-agent']).toBe('ObecniWebOdVoltu/2.0 https://test');
    expect(volani[0]!.hlavicky['if-modified-since']).toBeUndefined();

    ted.d = new Date(TED.getTime() + 20 * 60_000); // keš (Expires i 30 min)
    await s.obnov();
    expect(volani).toHaveLength(1);

    ted.d = new Date(TED.getTime() + 31 * 60_000); // Expires vypršel → podmíněný dotaz
    await s.obnov();
    expect(volani).toHaveLength(2);
    expect(volani[1]!.hlavicky['if-modified-since']).toBe('Fri, 23 Oct 2026 12:54:37 GMT');
    const st = await s.stav();
    expect(st.aktualizovano?.toISOString()).toBe(ted.d.toISOString());
    expect(st.dny).toHaveLength(7); // data z 304 zůstala

    ted.d = new Date(TED.getTime() + 70 * 60_000); // nový Expires (+90 min) ještě platí
    await s.obnov();
    expect(volani).toHaveLength(2);
  });

  it('výpadek zdroje → poslední známá data a chyba; po 12 h jsou data „stará“; přežijí restart', async () => {
    const ted = { d: TED };
    const { f, volani } = falesnyFetch([
      odpoved(FIXTURA, 200, hlavickyMet(TED)),
      odpoved({ x: 1 }, 500),
      () => {
        throw new Error('síť nedostupná');
      },
    ]);
    const s = nova(f, ted);
    await s.obnov();
    ted.d = new Date(TED.getTime() + 60 * 60_000);
    await s.obnov();
    let st = await s.stav();
    expect(st.chyba).toBe('HTTP 500');
    expect(st.stara).toBe(false);
    expect(st.dny.length).toBeGreaterThan(0);
    expect(st.aktualizovano?.toISOString()).toBe(TED.toISOString());

    ted.d = new Date(TED.getTime() + 13 * 3600_000);
    await s.obnov();
    expect(volani).toHaveLength(3);
    st = await s.stav();
    expect(st.chyba).toContain('síť');
    expect(st.stara).toBe(true);

    const s2 = nova(falesnyFetch([]).f, { d: new Date(TED.getTime() + 3600_000) });
    expect((await s2.stav()).dny).toHaveLength(7);
  });

  it('nečekaný tvar odpovědi data nesmaže', async () => {
    const ted = { d: TED };
    const s = nova(
      falesnyFetch([odpoved(FIXTURA, 200, hlavickyMet(TED)), odpoved({ properties: {} })]).f,
      ted,
    );
    await s.obnov();
    await s.obnov(true);
    const st = await s.stav();
    expect(st.chyba).toContain('neočekávaný');
    expect(st.ted?.teplota).toBe(11.8);
  });
});

describe('titulka a stránka /pocasi', () => {
  let t: TestApp;
  let spr: Prohlizec;
  beforeAll(async () => {
    t = await spustTestApp();
    spr = await prihlasSRoli(t, '777600091', ['spravce']);
    const s = t.app.pocasi!;
    s.hodiny = () => TED;
    s.fetchFn = falesnyFetch([odpoved(FIXTURA, 200, hlavickyMet(TED))]).f;
    await s.obnov(true);
  });
  afterAll(async () => t?.zavri());

  async function ulozVzhled(pole: Record<string, string>) {
    const f = await spr.get('/sprava/web/vzhled');
    return postSoubory(spr, '/sprava/web/vzhled', { _csrf: csrfZ(f.text), akce: 'ulozit', ...pole }, []);
  }

  it('výchozí: bílá karta pod rychlými odkazy, 3 dny, odkaz na 7 dní, zdroj — nic z cizích serverů', async () => {
    const { text } = await new Prohlizec(t.base).get('/');
    expect(text).toContain('pocasi-dlazdice pocasi-karta');
    expect(text).not.toContain('pocasi-sklo');
    expect(text.indexOf('id="rychle"')).toBeLessThan(text.indexOf('poc-karta-h'));
    expect(text.indexOf('poc-karta-h')).toBeLessThan(text.indexOf('h-aktuality'));
    expect(text).toContain('<p class="poc-teplota">12\u00a0°C</p>');
    expect(text).toContain('zítra');
    expect(text).toContain('alt="');
    expect(text).toContain('href="/pocasi"');
    expect(text).toContain('Předpověď: MET Norway (yr.no), licence CC BY 4.0');
    expect(text).toMatch(/src="\/static\/img\/pocasi\/[a-z_]+\.svg" alt="[a-zěščřžýáíéůú ]+"/);
    expect(text).not.toMatch(/<(img|script|iframe)[^>]+src="https?:\/\/(?!127\.0\.0\.1)/);
    expect(text).not.toContain('api.met.no');
  });

  it('umístění podle vzhledu: v úvodu (sklo, na telefonu karta), skryto; náhled ze sezení', async () => {
    await ulozVzhled({ pocasi_umisteni: 'uvod' });
    let text = (await new Prohlizec(t.base).get('/')).text;
    expect(text).toContain('pocasi-sklo jen-pocitac');
    expect(text).toContain('pocasi-karta jen-telefon');
    expect(text.indexOf('poc-uvod-h')).toBeLessThan(text.indexOf('id="rychle"'));

    await ulozVzhled({ pocasi_umisteni: 'skryto' });
    text = (await new Prohlizec(t.base).get('/')).text;
    expect(text).not.toContain('pocasi-dlazdice');
    expect((await new Prohlizec(t.base).get('/pocasi')).res.status).toBe(200);

    // náhled: správce vidí variantu, ostatní dál uloženou
    const f = await spr.get('/sprava/web/vzhled');
    expect(f.text).toContain('name="pocasi_umisteni" value="pod-odkazy"');
    const nahled = await postSoubory(
      spr,
      '/sprava/web/vzhled',
      { _csrf: csrfZ(f.text), akce: 'nahled', pocasi_umisteni: 'uvod' },
      [],
    );
    expect(nahled.text).toContain('pocasi-sklo');
    expect((await new Prohlizec(t.base).get('/')).text).not.toContain('pocasi-dlazdice');
    await spr.post('/sprava/web/vzhled/nahled-zrusit', { _csrf: csrfZ(nahled.text) });
    await ulozVzhled({ pocasi_umisteni: 'pod-odkazy' });
  });

  it('výstraha ČHMÚ v dlaždici a na /pocasi; zahozená a proběhlá ne', async () => {
    const od = new Date(TED.getTime() - 3600_000);
    const doo = new Date(TED.getTime() + 6 * 3600_000);
    await t.db
      .insertInto('ik_vystrahy')
      .values([
        {
          zdroj: 'chmu',
          externi_id: 'Silný vítr|orange',
          stupen: 'orange',
          titulek: 'Silný vítr',
          plati_od: od,
          plati_do: doo,
          detail: JSON.stringify({}),
          stav: 'odeslano',
        },
        {
          zdroj: 'chmu',
          externi_id: 'Mráz|yellow',
          stupen: 'yellow',
          titulek: 'Mráz zahozený',
          plati_od: od,
          plati_do: doo,
          detail: JSON.stringify({}),
          stav: 'zahozeno',
        },
        {
          zdroj: 'chmu',
          externi_id: 'Bouřky|red',
          stupen: 'red',
          titulek: 'Bouřky proběhlé',
          plati_od: new Date(TED.getTime() - 9 * 3600_000),
          plati_do: new Date(TED.getTime() - 3600_000),
          detail: JSON.stringify({}),
          stav: 'odeslano',
        },
      ])
      .execute();
    const { text } = await new Prohlizec(t.base).get('/');
    expect(text).toContain('poc-vystraha poc-v-orange');
    expect(text).toContain('Oranžová výstraha:</strong> Silný vítr');
    expect(text).toContain('href="/infokanal/vystrahy"');
    expect(text).not.toContain('Mráz zahozený');
    expect(text).not.toContain('Bouřky proběhlé');
    const st = await new Prohlizec(t.base).get('/pocasi');
    expect(st.text).toContain('Silný vítr');
    await t.db.deleteFrom('ik_vystrahy').execute();
  });

  it('stránka /pocasi: dnes, graf s popisem, tabulka po 3 h, 7 dní, zdroj', async () => {
    const { res, text } = await new Prohlizec(t.base).get('/pocasi');
    expect(res.status).toBe(200);
    expect(text).toContain('<h1>Počasí – Testov</h1>');
    expect(text).toMatch(/<svg viewBox="0 0 960 240" role="img" aria-labelledby="graf-t graf-d"/);
    expect(text).toContain('<details class="poc-tabulka">');
    expect((text.match(/<tr><th scope="row">/g) ?? []).length).toBe(16); // 48 h po 3 h
    expect((text.match(/<ul class="poc-tyden">[\s\S]*?<\/ul>/)![0].match(/<li>/g) ?? []).length).toBe(7);
    expect(text).toContain('href="https://www.yr.no/"');
    expect(text).toContain('Teď neplatí žádná výstraha ČHMÚ.');
  });

  it('stará data: na titulce nic, stránka upozorní', async () => {
    const s = t.app.pocasi!;
    s.hodiny = () => new Date(TED.getTime() + 13 * 3600_000);
    try {
      expect((await new Prohlizec(t.base).get('/')).text).not.toContain('pocasi-dlazdice');
      expect((await new Prohlizec(t.base).get('/pocasi')).text).toContain('Předpověď je stará');
    } finally {
      s.hodiny = () => TED;
    }
  });

  it('modul vypnutý ve Správě → Moduly obce: /pocasi 404 a na titulce nic; /api/moduly ho nevypisuje', async () => {
    await t.app.moduly.uloz({ pocasi: false }, { uzivatelId: null });
    try {
      expect((await new Prohlizec(t.base).get('/pocasi')).res.status).toBe(404);
      expect((await new Prohlizec(t.base).get('/')).text).not.toContain('pocasi-dlazdice');
      const j = (await (await fetch(t.base + '/api/moduly')).json()) as {
        moduly: { klic: string }[];
        zapnuto: Record<string, boolean>;
      };
      expect(j.moduly.map((m) => m.klic)).not.toContain('pocasi');
      expect(j.zapnuto).not.toHaveProperty('pocasi');
    } finally {
      await t.app.moduly.uloz({ pocasi: true }, { uzivatelId: null });
    }
  });
});

describe('modul vypnutý v obec.yml', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp({
      obec: obecZObjektu({
        obec: { nazev: 'Obec Testov', kratky_nazev: 'Testov', casti: ['Testov'] },
        moduly: { web: true },
      }),
    });
  });
  afterAll(async () => t?.zavri());

  it('žádná služba, /pocasi neexistuje, ve vzhledu není volba', async () => {
    expect(t.app.pocasi).toBeUndefined();
    expect((await new Prohlizec(t.base).get('/pocasi')).res.status).toBe(404);
    expect((await new Prohlizec(t.base).get('/')).text).not.toContain('pocasi-dlazdice');
  });
});
