// Vývoj počtu obyvatel: tabulka MV ČR ze stránky mistopisy.cz (parser nad uloženou stránkou), vlastní SVG graf,
// služba s podstrčeným stažením (chyba zdroje nic nesmaže) a vykreslení bloku + zástupky {{pocet_obyvatel}} na stránce.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grafObyvatel,
  KLIC_NASTAVENI,
  ObyvateleVyvojSluzba,
  parsujMistopisy,
  type RokObyvatel,
} from '../src/moduly/web/obyvatele-vyvoj.js';
import { potrebujeObyvatele, rozdelObsah } from '../src/moduly/web/vlozene.js';
import { csrfZ, postSoubory, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

const STRANKA = readFileSync(new URL('./fixtures/mistopisy-pocet-obyvatel.html', import.meta.url), 'utf8');

describe('parser tabulky mistopisy.cz', () => {
  it('vytáhne roky 2013–2026 se složením a součtem', () => {
    const roky = parsujMistopisy(STRANKA);
    expect(roky.map((r) => r.rok)).toEqual([
      2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
    ]);
    expect(roky.at(-1)).toEqual({
      rok: 2026,
      muziDeti: 31,
      muziDospeli: 129,
      zenyDeti: 28,
      zenyDospele: 155,
      celkem: 343,
    });
    expect(roky[0]).toEqual({
      rok: 2013,
      muziDeti: 13,
      muziDospeli: 96,
      zenyDeti: 19,
      zenyDospele: 113,
      celkem: 241,
    });
  });
  it('stránka bez tabulky dá prázdné pole; řádek se špatným součtem se přeskočí', () => {
    expect(parsujMistopisy('<html><body><p>Nic</p></body></html>')).toEqual([]);
    expect(
      parsujMistopisy(
        'Historie počtu obyvatel <td>1.1.2020</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>99</td>',
      ),
    ).toEqual([]);
    expect(
      parsujMistopisy(
        'Historie počtu obyvatel <td>1.1.2020</td><td>1</td><td>2</td><td>3</td><td>4</td><td>-2</td><td>10</td>',
      ),
    ).toEqual([{ rok: 2020, muziDeti: 1, muziDospeli: 2, zenyDeti: 3, zenyDospele: 4, celkem: 10 }]);
  });
});

describe('graf', () => {
  it('jedna řada, popisek u prvního a posledního roku, sloupce v pořadí let', () => {
    const roky = parsujMistopisy(STRANKA);
    const g = grafObyvatel(roky, (r) => `${r.rok}: ${r.celkem}`)!;
    expect(g.sloupce).toHaveLength(14);
    expect(g.sloupce[0]).toMatchObject({ rok: 2013, prvni: true, posledni: false, popis: '2013: 241' });
    expect(g.popisky.map((p) => p.text)).toEqual(['241', '343']);
    expect(grafObyvatel([], () => '')).toBeNull();
  });
});

describe('služba', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t.zavri());

  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as ConstructorParameters<
    typeof ObyvateleVyvojSluzba
  >[3];
  const odpoved = (status: number, text: string) =>
    (async () =>
      new Response(text, { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

  it('stáhne a uloží tabulku; chyba zdroje nechá poslední známá data a zapíše ji', async () => {
    const url = 'https://www.mistopisy.cz/pruvodce/obec/1/testov/pocet-obyvatel/';
    const s = new ObyvateleVyvojSluzba(
      t.db,
      url,
      'test',
      log,
      odpoved(200, STRANKA),
      () => new Date('2026-10-31T10:00:00Z'),
    );
    expect(await s.potrebaObnovy()).toBe(true);
    await s.obnov();
    let st = await s.stav((r) => String(r.rok));
    expect(st.posledni?.celkem).toBe(343);
    expect(st.chyba).toBeNull();
    expect(st.posledniUspech?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    // uložené v nastaveni — druhá instance to načte bez stahování
    const s2 = new ObyvateleVyvojSluzba(
      t.db,
      url,
      'test',
      log,
      odpoved(500, 'x'),
      () => new Date('2026-11-01T10:00:00Z'),
    );
    expect(await s2.potrebaObnovy()).toBe(false); // týden ještě neuplynul
    await s2.obnov(true);
    st = await s2.stav((r) => String(r.rok));
    expect(st.posledni?.celkem).toBe(343);
    expect(st.chyba).toBe('HTTP 500');
    expect(st.posledniUspech?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
    const ulozeno = await t.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirstOrThrow();
    expect((ulozeno.hodnota as { roky: RokObyvatel[] }).roky).toHaveLength(14);
    // jiná adresa zdroje = stará data se nepoužijí
    const s3 = new ObyvateleVyvojSluzba(t.db, url + '?x', 'test', log, odpoved(500, 'x'), () => new Date());
    expect((await s3.stav(() => '')).roky).toEqual([]);
  });

  it('rozdelObsah: blok vývoje a zástupka počtu', () => {
    const html =
      '<p>Žije tu {{pocet_obyvatel}} lidí.</p><figure class="obyvatele-vyvoj" data-obyvatele="vyvoj"><p>Vývoj</p></figure><p>Konec.</p>';
    expect(potrebujeObyvatele(html)).toBe(true);
    expect(potrebujeObyvatele('<p>{{ pocet_obyvatel }}</p>')).toBe(true);
    expect(potrebujeObyvatele('<p>nic</p>')).toBe(false);
    const roky = parsujMistopisy(STRANKA);
    const data = {
      roky,
      posledni: roky.at(-1)!,
      nejstarsi: roky[0]!,
      graf: grafObyvatel(roky, () => ''),
      posledniUspech: null,
      chyba: null,
      zdrojUrl: 'x',
    };
    const kusy = rozdelObsah(html, new Map(), new Map(), { obyvatele: data, pocetObyvatel: 353 });
    expect(kusy).toHaveLength(3);
    expect(kusy[0]).toEqual({ html: '<p>Žije tu 353 lidí.</p>' });
    expect('obyvatele' in kusy[1]!).toBe(true);
    // bez dat blok tiše zmizí a zástupka je prázdná
    const bez = rozdelObsah(html, new Map(), new Map(), {});
    expect(bez).toEqual([{ html: '<p>Žije tu  lidí.</p>' }, { html: '<p>Konec.</p>' }]);
  });

  it('stránka s blokem: sanitizer blok zachová, web vykreslí graf, tabulku a aktuální počet z administrace', async () => {
    const red = await prihlasSRoli(t, '777600001', ['web']);
    const spr = await prihlasSRoli(t, '777600002', ['spravce']);
    await new ObyvateleVyvojSluzba(
      t.db,
      t.app.obec.obyvatele.mistopisy_url,
      'test',
      log,
      odpoved(200, STRANKA),
    ).obnov(true);
    // ruční počet obyvatel z administrace
    const f = await spr.get('/sprava');
    await spr.post('/sprava/web/obyvatele', { _csrf: csrfZ(f.text), pocet: '353' });
    const form = await red.get('/sprava/web/novy?typ=stranka');
    await postSoubory(
      red,
      '/sprava/web/novy',
      {
        _csrf: csrfZ(form.text),
        typ: 'stranka',
        titulek: 'Obyvatelstvo test',
        obsah_html:
          '<h2>Obyvatelstvo</h2><p>Dnes žije v obci {{pocet_obyvatel}} obyvatel.</p>' +
          '<figure class="obyvatele-vyvoj" data-obyvatele="vyvoj"><p>Vývoj počtu obyvatel</p></figure>' +
          '<figure class="obyvatele-vyvoj" data-obyvatele="hack"><p>x</p></figure>',
        akce: 'zverejnit',
      },
      [],
    );
    const o = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Obyvatelstvo test')
      .executeTakeFirstOrThrow();
    expect(o.obsah_html).toContain('<figure class="obyvatele-vyvoj" data-obyvatele="vyvoj">');
    expect(o.obsah_html).not.toContain('hack');
    const pub = await new Prohlizec(t.base).get(`/${o.slug}`);
    expect(pub.res.status).toBe(200);
    expect(pub.text).toContain('Dnes žije v obci 353 obyvatel.');
    expect(pub.text).toContain('<svg viewBox="0 0 760 230"');
    expect(pub.text).toContain('K 1. 1. 2026 měla obec podle evidence Ministerstva vnitra 343 obyvatel');
    expect(pub.text).toContain('Od roku 2013 (241 obyvatel) je to změna o +102.');
    expect(pub.text).toContain('<th scope="row">1. 1. 2013</th>');
    expect(pub.text).toContain('mistopisy.cz');
    expect(pub.text).not.toContain('data-obyvatele=');
    expect(pub.text).not.toContain('{{');
  });
});
