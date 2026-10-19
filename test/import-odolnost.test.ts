// Odolnost importu (nálezy code review): vadná položka nesmí shodit celý import, článek se zakládá jen spolu
// s přesměrováním, média jen ze starého webu obce, text ze zdroje se nevykládá jako vzor náhrady, líně načítané
// obrázky, relativní adresy vůči stránce, kotvy, menu nesahá na ruční úpravy redakce.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRAZDNA_POLE } from '../src/moduly/web/obsah.js';
import { textTagu } from '../src/moduly/web/import/html-pomoc.js';
import { Importer, jmenoSouboru } from '../src/moduly/web/import/importer.js';
import type { ImportniZdroj, Stahovac } from '../src/moduly/web/import/typy.js';
import { MALE_PDF, prihlasSRoli, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
let obrazek: Buffer;
beforeAll(async () => {
  t = await spustTestApp();
  obrazek = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#00aa00' } })
    .png()
    .toBuffer();
});
afterAll(async () => t.zavri());

const Z = 'https://stara-obec.cz';
const stazene: string[] = [];
const stahovac: Stahovac = {
  stazeno: 0,
  async text() {
    return '';
  },
  async json() {
    throw new Error('ne');
  },
  async soubor(url) {
    stazene.push(url);
    if (url.endsWith('.pdf')) return { data: MALE_PDF, typ: 'application/pdf' };
    if (/\.(png|jpg)$/.test(url)) return { data: obrazek, typ: 'image/png' };
    return null;
  },
};

function importer(zdroj: ImportniZdroj) {
  return new Importer(
    zdroj,
    {
      db: t.db,
      obsah: t.app.web.obsah,
      soubory: t.app.soubory,
      presmerovani: t.app.web.presmerovani,
      dotace: t.app.web.dotace,
      deska: t.app.deska,
    },
    stahovac,
    { aktualityOd: new Date('2020-01-01') },
  );
}

const zaklad = { nazev: 'test', zaklad: Z, async *stranky() {} } as const;

describe('odolnost importu', () => {
  it('neplatné datum ani %zz v adrese import neshodí; ostatní položky se naimportují', async () => {
    const v = await importer({
      ...zaklad,
      async *aktuality() {
        yield {
          url: `${Z}/spatne-datum/`,
          titulek: 'Zpráva s neplatným datem',
          html: '<p>x</p>',
          datum: new Date('nesmysl'),
        };
        yield {
          url: `${Z}/procenta/`,
          titulek: 'Zpráva s vadnou adresou obrázku',
          html: `<p><img src="/wp-content/uploads/foto%zz.png" alt="Foto"> <a href="/dokument%zz.pdf">Dokument</a></p>`,
          datum: new Date('2025-05-01T10:00:00Z'),
          obrazekUrl: `${Z}/wp-content/uploads/titul%zz.png`,
        };
        yield {
          url: `${Z}/dobra/`,
          titulek: 'Dobrá zpráva',
          html: '<p>v pořádku</p>',
          datum: new Date('2025-05-02T10:00:00Z'),
        };
      },
    }).spust();
    expect(v.aktuality).toBe(2);
    expect(v.chyby.some((c) => c.includes('spatne-datum') && c.includes('datum'))).toBe(true);
    const procenta = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('puvodni_url', '=', `${Z}/procenta/`)
      .executeTakeFirstOrThrow();
    expect(procenta.obsah_html).toMatch(/<img src="\/soubory\//);
    expect(procenta.obrazek_id).not.toBeNull();
    expect(jmenoSouboru(`${Z}/a%zz.pdf`)).toBe('a%zz.pdf');
  });

  it('článek a jeho přesměrování v jedné transakci: když přesměrování selže, nezůstane ani článek', async () => {
    // %00 v původní adrese: řádek článku se uloží, přesměrování (dekódovaná cesta s NUL) ne → rollback
    const v = await importer({
      ...zaklad,
      async *aktuality() {
        yield {
          url: `${Z}/vadna%00adresa/`,
          titulek: 'Článek s nepřenositelnou adresou',
          html: '<p>x</p>',
          datum: new Date('2025-06-01T10:00:00Z'),
        };
        yield {
          url: `${Z}/dalsi-clanek/`,
          titulek: 'Další článek',
          html: '<p>y</p>',
          datum: new Date('2025-06-02T10:00:00Z'),
        };
      },
    }).spust();
    expect(v.aktuality).toBe(1);
    expect(v.chyby.some((c) => c.includes('vadna%00adresa'))).toBe(true);
    expect(
      await t.db
        .selectFrom('web_obsah')
        .select('id')
        .where('puvodni_url', '=', `${Z}/vadna%00adresa/`)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await t.app.web.presmerovani.cil('/dalsi-clanek')).toBe('/aktuality/dalsi-clanek');
  });

  it('média jen ze starého webu: úvodní obrázek, přílohy desky ani plakát odjinud se nestahují', async () => {
    stazene.length = 0;
    const v = await importer({
      ...zaklad,
      async *aktuality() {
        yield {
          url: `${Z}/cizi-obrazek/`,
          titulek: 'Zpráva s cizím úvodním obrázkem',
          html: '<p>text</p>',
          datum: new Date('2025-07-01T10:00:00Z'),
          obrazekUrl: 'http://169.254.169.254/latest/meta-data/x.png',
        };
      },
      async *deska() {
        yield {
          url: `${Z}/deska/cizi-priloha/`,
          nazev: 'Oznámení s cizí přílohou',
          html: '<p>Oznámení</p>',
          vyvesenoOd: new Date('2025-07-01T10:00:00Z'),
          kategorie: 'ostatni',
          prilohy: [{ url: 'http://localhost:5432/x.pdf' }, { url: `${Z}/u/vlastni.pdf` }],
        };
      },
    }).spust();
    expect(v.chyby).toEqual([]);
    expect(stazene).toEqual([`${Z}/u/vlastni.pdf`]);
    const dok = await t.db
      .selectFrom('ud_dokumenty')
      .select('id')
      .where('puvodni_url', '=', `${Z}/deska/cizi-priloha/`)
      .executeTakeFirstOrThrow();
    expect(await t.app.deska.prilohy(dok.id)).toHaveLength(1);
  });

  it('přepis HTML: $& v popisu, líně načítaný obrázek, relativní adresa vůči stránce, kotva', async () => {
    stazene.length = 0;
    const { html } = await importer({ ...zaklad, async *aktuality() {} }).prepisHtml(
      `<p><img src="data:image/gif;base64,R0lGOD" data-src="/u/line.jpg" alt="Cena $& a $1">` +
        `<img src="foto.png" alt="Relativní"> <a href="/obec/#historie">Historie</a></p>`,
      'Test',
      `${Z}/obec/kultura/`,
    );
    expect(html).toContain('alt="Cena $&amp; a $1"');
    expect(stazene).toEqual([`${Z}/u/line.jpg`, `${Z}/obec/kultura/foto.png`]);
    expect(html).toContain('href="/obec#historie"');
  });

  it('textTagu je lineární i pro text plný neuzavřených „<“', () => {
    const zacatek = Date.now();
    expect(textTagu('<'.repeat(200_000)).length).toBe(200_000);
    expect(textTagu('<b>tučně</b> a <i>kurzíva')).toBe('tučně a kurzíva');
    expect(Date.now() - zacatek).toBeLessThan(1000);
  });

  it('menu importu nechá být odkazy, které přidala redakce, a zplošťuje jen importované stránky', async () => {
    const red = await prihlasSRoli(t, '777600001', ['web']);
    void red;
    const autor = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777600001')
      .executeTakeFirstOrThrow();
    const rucni = await t.app.web.obsah.uloz(
      null,
      'odkaz',
      { ...PRAZDNA_POLE, titulek: 'Ruční odkaz redakce', odkaz_url: '/kontakt', v_menu: true },
      'zverejnit',
      autor.id,
    );
    // ruční dvouúrovňová struktura redakce (rodič → dítě) mimo import
    const rodic = await t.app.web.obsah.uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Ruční rodič', v_menu: true },
      'zverejnit',
      autor.id,
    );
    const dite = await t.app.web.obsah.uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Ruční dítě', nadrazena_id: rodic },
      'zverejnit',
      autor.id,
    );
    const v = await importer({
      ...zaklad,
      async *stranky() {
        yield { klic: 'a', url: `${Z}/a/`, titulek: 'Importovaná A', html: '<p>a</p>' };
      },
      async *aktuality() {},
      async menu() {
        return [{ titulek: 'A', url: `${Z}/a/`, deti: [] }];
      },
    }).spust();
    expect(v.chyby).toEqual([]);
    expect((await t.app.web.obsah.podleId(rucni))?.v_menu).toBe(true);
    expect((await t.app.web.obsah.podleId(dite))?.nadrazena_id).toBe(rodic);
    const menu = await t.app.web.obsah.menu();
    expect(menu.map((m) => m.titulek)).toEqual(
      expect.arrayContaining(['Ruční odkaz redakce', 'Importovaná A']),
    );
  });
});
