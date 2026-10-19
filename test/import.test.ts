// Import ze starého webu: falešný zdroj + falešné stahování (žádná síť). Ověřuje přepis médií a odkazů,
// strom stránek, menu, úřední desku (lhůty, rozpočet), přesměrování a idempotenci.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hezkyTitulek, Importer, odhadniRozpocet } from '../src/moduly/web/import/importer.js';
import { parsujMenu } from '../src/moduly/web/import/html-pomoc.js';
import { kategorieDesky } from '../src/moduly/web/import/wordpress.js';
import type { ImportniZdroj, Stahovac } from '../src/moduly/web/import/typy.js';
import { MALE_PDF, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());

const Z = 'https://stara-obec.cz';
let obrazek: Buffer;
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
    if (url.endsWith('.png') || url.endsWith('.jpg')) return { data: obrazek, typ: 'image/png' };
    return null;
  },
};

const zdroj: ImportniZdroj = {
  nazev: 'test',
  zaklad: Z,
  async *stranky() {
    yield {
      klic: '1',
      url: `${Z}/obec/`,
      titulek: 'Obec',
      html: '<p>O obci <img src="/wp-content/uploads/znak.png" alt=""></p>',
      rodic: null,
    };
    yield {
      klic: '2',
      url: `${Z}/obec/historie/`,
      titulek: 'Historie',
      html: '<p>Dávno. <a href="https://stara-obec.cz/obec/">zpět</a></p><p><a href="/obec/historie/foto-1/"><img src="/wp-content/uploads/kaple-150x150.jpg" alt=""></a></p>',
      rodic: '1',
    };
    yield {
      klic: '3',
      url: `${Z}/obec/historie/kronika/`,
      titulek: 'Kronika',
      html: '<p>Kronika</p>',
      rodic: '2',
    };
    yield {
      klic: '4',
      url: `${Z}/kontakty/`,
      titulek: 'Kontakty',
      html: '<p>Úřad</p><script>alert(1)</script><img src="https://cizi-server.cz/widget.png">',
    };
  },
  async *aktuality() {
    yield {
      url: `${Z}/2025/03/svoz/`,
      titulek: 'Svoz odpadu',
      html: '<p>Text</p><p><a href="/wp-content/uploads/2025/03/rozpis.pdf">Rozpis</a> <a href="/wp-content/uploads/2025/03/rozpis.pdf">Stáhnout</a></p>',
      datum: new Date('2025-03-02T10:00:00Z'),
      kategorie: 'ou-informuje',
      obrazekUrl: `${Z}/wp-content/uploads/popelnice.jpg`,
    };
  },
  async *deska() {
    yield {
      url: `${Z}/2025/01/navrh/`,
      nazev: 'Návrh rozpočtu na rok 2025',
      html: '<p><a href="/u/navrh.pdf">Návrh</a></p>',
      vyvesenoOd: new Date('2024-11-20T10:00:00Z'),
      kategorie: 'rozpocet',
    };
    yield {
      url: `${Z}/2025/01/rozpocet/`,
      nazev: 'Rozpočet obce 2025',
      html: '<p><a href="/u/rozpocet.pdf">Rozpočet</a></p>',
      vyvesenoOd: new Date('2024-12-20T10:00:00Z'),
      kategorie: 'rozpocet',
    };
    yield {
      url: `${Z}/2025/02/zamer/`,
      nazev: 'Záměr prodeje pozemku',
      html: '<p>Prodej louky.</p>',
      vyvesenoOd: new Date('2025-02-01T10:00:00Z'),
      kategorie: 'zamery',
    };
  },
  async menu() {
    return [
      { titulek: 'ÚVOD', url: `${Z}/`, deti: [] },
      {
        titulek: 'OBEC',
        url: `${Z}/obec/`,
        deti: [
          { titulek: 'Historie', url: `${Z}/obec/historie/`, deti: [] },
          { titulek: 'více →', url: `${Z}/obec/`, deti: [] },
        ],
      },
      { titulek: 'Úřední deska', url: `${Z}/category/deska/`, deti: [] },
      {
        titulek: 'Služby',
        url: null,
        deti: [
          { titulek: 'Můj účet', url: 'https://ucet.jinde.cz/', deti: [] },
          { titulek: 'Odpady', url: `${Z}/category/deska/`, deti: [] },
        ],
      },
      { titulek: 'Kontakty', url: `${Z}/kontakty/`, deti: [] },
    ];
  },
  async presmerovani() {
    return { [`${Z}/category/deska/`]: '/uredni-deska' };
  },
  async dotace() {
    return [
      { projekt: 'Hřiště', poskytovatel: 'Kraj', loga: [{ url: `${Z}/u/logo.png`, alt: 'Logo kraje' }] },
    ];
  },
};

function importer() {
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
    { aktualityOd: new Date('2020-01-01'), kategorieAktualit: { 'ou-informuje': 'obecni-urad' } },
  );
}

describe('pomůcky importu', () => {
  it('rozpočtové dokumenty podle názvu', () => {
    expect(odhadniRozpocet('Návrh rozpočtu na rok 2025', new Date('2024-11-01'))).toEqual({
      typ: 'navrh_rozpoctu',
      rok: 2025,
    });
    expect(odhadniRozpocet('RO č.3/2026', new Date('2026-09-17'))).toEqual({
      typ: 'rozpoctove_opatreni',
      rok: 2026,
    });
    expect(odhadniRozpocet('Střednědobý výhled rozpočtu 2026–2028', new Date())).toEqual({
      typ: 'vyhled',
      rok: 2026,
    });
    expect(odhadniRozpocet('Závěrečný účet obce za rok 2025', new Date())).toEqual({
      typ: 'zaverecny_ucet',
      rok: 2025,
    });
    expect(odhadniRozpocet('Pozvánka na zasedání', new Date())).toBeNull();
    expect(
      odhadniRozpocet(
        'Plán odpadového hospodářství LK na období 2016 – 2025 s výhledem do roku 2035',
        new Date(),
      ),
    ).toBeNull();
  });
  it('kategorie úřední desky podle názvu', () => {
    expect(kategorieDesky('Zápis ze zasedání ZO ze dne 16. 9. 2026', ['zastupitelstvo'])).toBe(
      'zastupitelstvo',
    );
    expect(kategorieDesky('Veřejná vyhláška – oznámení o zahájení řízení', [])).toBe('verejne-vyhlasky');
    expect(kategorieDesky('Záměr pronájmu pozemku', [])).toBe('zamery');
    expect(kategorieDesky('RO č.3/2026', ['rozpocet-obce'])).toBe('rozpocet');
    expect(kategorieDesky('Pozvánka na členskou schůzi DSO Mikroregion Jizera', [])).toBe('jine-urady');
    // exekuce a dražby jsou vždy jiný úřad — i s „usnesením“ v názvu nebo v kategorii zastupitelstva (nález auditu)
    expect(
      kategorieDesky(
        'Usnesení č.j. 151 EX 227/16-232 ze dne 29.10.2018 k uspokojení pohledávky proti povinnému',
        ['zastupitelstvo'],
      ),
    ).toBe('jine-urady');
    expect(kategorieDesky('Usnesení Exekutorského úřadu', [])).toBe('jine-urady');
    expect(kategorieDesky('Dražební vyhláška', [])).toBe('jine-urady');
    expect(kategorieDesky('Usnesení vlády ČR ze dne 8. 10. 2020', [])).toBe('jine-urady');
    expect(kategorieDesky('Finanční úřad – veřejná vyhláška', [])).toBe('jine-urady');
    expect(kategorieDesky('Pozvánka na zasedání zastupitelstva obce', [])).toBe('pozvanky-zo');
    expect(kategorieDesky('Usnesení ze zasedání ZO č. 5/2026', [])).toBe('zastupitelstvo');
  });
  it('menu z HTML a titulky z VELKÝCH písmen', () => {
    const m = parsujMenu(
      '<nav><ul class="menu"><li><a href="/a">A</a><ul><li><a href="/a/b">B &amp; C</a></li></ul></li><li><a href="/d">D</a></li></ul></nav>',
      undefined,
      Z,
    );
    expect(m).toEqual([
      { titulek: 'A', url: `${Z}/a`, deti: [{ titulek: 'B & C', url: `${Z}/a/b`, deti: [] }] },
      { titulek: 'D', url: `${Z}/d`, deti: [] },
    ]);
    expect(hezkyTitulek('OBECNÍ ÚŘAD')).toBe('Obecní úřad');
    expect(hezkyTitulek('Obec')).toBe('Obec');
  });
});

describe('import', () => {
  it('importuje obsah, média, menu, desku a přesměrování; podruhé nic nezdvojí', async () => {
    obrazek = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#aa0000' } })
      .png()
      .toBuffer();
    const v = await importer().spust();
    expect(v).toMatchObject({ stranky: 4, aktuality: 1, deska: 3, dotace: 1 });
    // cizí obrázek se nestahuje, stejný soubor jen jednou
    expect(stazene.some((u) => u.includes('cizi-server'))).toBe(false);
    expect(stazene.filter((u) => u.endsWith('rozpis.pdf'))).toHaveLength(1);
    // strom: Kronika (3. úroveň) pod nejvyšším předkem; menu: OBEC je rozcestník s Obcí a Historií
    const obec = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('puvodni_url', '=', `${Z}/obec/`)
      .executeTakeFirstOrThrow();
    const kronika = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Kronika')
      .executeTakeFirstOrThrow();
    expect(kronika.nadrazena_id).not.toBeNull();
    const menu = await t.app.web.obsah.menu();
    const polozkaObec = menu.find((m) => m.titulek === 'Obec')!;
    expect(polozkaObec.deti.map((d) => d.titulek)).toEqual(expect.arrayContaining(['Historie']));
    expect(menu.find((m) => m.titulek === 'Úřední deska')?.url).toBe('/uredni-deska');
    expect(menu.some((m) => m.titulek === 'Úvod' || m.titulek === 'ÚVOD')).toBe(false);
    // cizí odkaz zůstává, kategorie si ponechá svůj cíl; výchozí menu instalace je skryté
    const sluzby = menu.find((m) => m.titulek === 'Služby')!;
    expect(sluzby.deti.map((d) => d.url)).toEqual(['https://ucet.jinde.cz/', '/uredni-deska']);
    expect(menu.filter((m) => m.titulek === 'Úřední deska')).toHaveLength(1);
    // HTML: obrázek přeuložený, popis se z názvu souboru nevymýšlí (prázdný = „chybí popis“ pro redaktora),
    // script pryč, odkaz na vlastní stránku relativní, „Stáhnout“ bez duplicity
    expect(obec.obsah_html).toMatch(/<img src="\/soubory\/[^"]+" alt="" \/>/);
    const kontakty = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Kontakty')
      .executeTakeFirstOrThrow();
    expect(kontakty.obsah_html).not.toContain('script');
    expect(kontakty.obsah_html).not.toContain('cizi-server');
    const historie = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Historie')
      .executeTakeFirstOrThrow();
    expect(historie.obsah_html).toContain('href="/obec"');
    // zmenšenina → originál; odkaz na stránku přílohy → přímo na fotku
    expect(stazene).toContain(`${Z}/wp-content/uploads/kaple.jpg`);
    expect(historie.obsah_html).toMatch(/<a href="(\/soubory\/[^"]+)"><img src="\1"/);
    // řada dvou a více takových obrázků se stane mřížkou náhledů
    const { html: galerie } = await importer().prepisHtml(
      '<a href="/u/a.jpg"><img src="/u/a.jpg" alt="Kaple"></a> <br style="clear:both"> <a href="/u/b.jpg"><img src="/u/b.jpg" alt="Náves"></a>',
      'Galerie',
    );
    expect(galerie).toMatch(
      /^<figure class="galerie"><a href="\/soubory\/[^"]+"><img src="\/soubory\/[^"]+\?v=nahled" alt="Kaple" \/><\/a><a /,
    );
    const svoz = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Svoz odpadu')
      .executeTakeFirstOrThrow();
    expect(svoz.obsah_html).not.toContain('Stáhnout');
    expect(svoz.obrazek_id).not.toBeNull();
    // přesměrování starých adres
    const p = new Prohlizec(t.base);
    const r = await p.get('/2025/03/svoz/', false);
    expect(r.res.status).toBe(301);
    expect(r.res.headers.get('location')).toBe('/aktuality/svoz-odpadu');
    const h = await p.get('/obec/historie/', false);
    expect(h.res.headers.get('location')).toMatch(/historie$/);
    // úřední deska: rozpočet nahradil návrh, záměr visí 15 dní, přílohy
    const navrh = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Návrh rozpočtu na rok 2025')
      .executeTakeFirstOrThrow();
    expect(navrh.sejmuto_do).not.toBeNull();
    const rozpocet = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Rozpočet obce 2025')
      .executeTakeFirstOrThrow();
    expect(rozpocet).toMatchObject({ typ_rozpoctu: 'rozpocet', rok: 2025, sejmuto_do: null });
    expect(await t.app.deska.prilohy(rozpocet.id)).toHaveLength(1);
    const zamer = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Záměr prodeje pozemku')
      .executeTakeFirstOrThrow();
    expect(Math.round((zamer.sejmuto_do!.getTime() - zamer.vyveseno_od.getTime()) / 86_400_000)).toBe(16);
    // podruhé: nic nového
    const v2 = await importer().spust();
    expect(v2).toMatchObject({ stranky: 0, aktuality: 0, deska: 0, dotace: 0 });
    expect(
      await t.db
        .selectFrom('web_obsah')
        .select('id')
        .where('typ', '=', 'stranka')
        .where('smazano_at', 'is', null)
        .execute(),
    ).toHaveLength(6); // 4 stránky + 2 rozcestníky z menu
  });
});

describe('adaptér Galileo (HTML)', () => {
  it('čte menu, stránku, aktuality a úřední desku ze struktury Galilea', async () => {
    const { GalileoZdroj, ceskeDatum, obsahStranky } = await import('../src/moduly/web/import/galileo.js');
    expect(ceskeDatum('Vyvěšeno: 2. 1. 2026')).toBe('2026-01-02');
    const G = 'https://obec-galileo.cz';
    const stranka = (h1: string, obsah: string) =>
      `<div class="gcm-main"><h1>${h1}</h1><div class="editor_content readable"><div><p>${obsah}</p></div></div></div><div class="gcm-vertical-column"></div>`;
    const html: Record<string, string> = {
      [`${G}/`]: `<nav id="menu"><ul class="nav"><li><a class="nav-link" href="/obec/historie/">Obec</a><ul class="nav"><li><a href="/obec/historie/">Historie</a></li><li><a href="/obec/odpady/">Odpady</a></li></ul></li><li><a href="/urad/uredni-deska/">Úřední deska</a></li><li><a href="/zivot/aktuality/">Aktuality</a></li></ul></nav>`,
      [`${G}/obec/historie/`]: stranka('Historie obce', 'První zmínka 1543.'),
      [`${G}/obec/odpady/`]: stranka('Odpady', 'Svoz ve středu.'),
      [`${G}/zivot/aktuality/?page=all`]: `<a href="/zivot/aktuality/volby-368cs.html" class="event-link"><div class="event"><h3 class="event-name">Volby</h3><span class="event-info-value event-date">14. 10. 2026</span><p class="event-perex">Druhé kolo.</p></div></a>`,
      [`${G}/zivot/aktuality/volby-368cs.html`]: stranka('Volby do Senátu', 'Volební místnost v hasičárně.'),
      [`${G}/urad/uredni-deska/?show=0`]: `<div class="category card rozpocet-11"><div class="card-header"><h2 class="readable_item"><a> Rozpočet a finance </a></h2></div><div class="card-body"><div class="item"><div class="item-heading"><a class="item-href" href="/urad/uredni-deska/rozpocet-2026-2099.html?kshow=11">Schválený rozpočet roku 2026</a></div><div class="item-data"><span class="item-date item-date-from">Vyvěšeno: 2. 1. 2026</span> <span class="item-date item-date-to">Datum sejmutí: 31. 12. 2026</span></div></div></div></div>`,
      [`${G}/urad/uredni-deska/?show=1`]: '',
      [`${G}/urad/uredni-deska/rozpocet-2026-2099.html`]: `<div class="gcm-main"><h1>Schválený rozpočet roku 2026</h1><div class="module_content"><div class="official-desk-detail readable"><div class="content"><p><a class="file" href="/e_download.php?file=/data/uredni_deska/obsah188_1.pdf&amp;original=Rozpo%C4%8Det%202026.pdf">Rozpočet 2026.pdf</a><i> Typ: PDF dokument, Velikost: 81.01 kB</i></p></div></div></div></div>`,
    };
    const st: Stahovac = {
      stazeno: 0,
      async text(url) {
        if (!(url in html)) throw new Error('404 ' + url);
        return html[url]!;
      },
      async json() {
        throw new Error('ne');
      },
      async soubor(url) {
        stazene.push(url);
        return { data: MALE_PDF, typ: 'application/pdf' };
      },
    };
    const z = new GalileoZdroj({ zaklad: G, stahovac: st });
    const stranky = [];
    for await (const s of z.stranky()) stranky.push(s);
    expect(stranky.map((s) => s.titulek)).toEqual(['Historie obce', 'Odpady']);
    expect(obsahStranky(html[`${G}/obec/odpady/`]!).html).toContain('Svoz ve středu.');
    // obsah v modulu (bez editor_content) se vezme z hlavního bloku
    const modul = obsahStranky(
      '<div class="gcm-main"><h1>Úřad</h1><div class="module_content"><p>Starosta: Jan</p></div></div>',
    );
    expect(modul.titulek).toBe('Úřad');
    expect(modul.html).toContain('Starosta: Jan');
    expect(modul.html).not.toContain('<h1');
    const akt = [];
    for await (const a of z.aktuality(new Date('2026-01-01'))) akt.push(a);
    expect(akt).toHaveLength(1);
    expect(akt[0]).toMatchObject({ titulek: 'Volby do Senátu', perex: 'Druhé kolo.' });
    const docs = [];
    for await (const d of z.deska()) docs.push(d);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      nazev: 'Schválený rozpočet roku 2026',
      kategorie: 'rozpocet',
      url: `${G}/urad/uredni-deska/rozpocet-2026-2099.html`,
    });
    expect(docs[0]!.sejmutoDo).not.toBeNull();
    // přes importér: příloha z e_download.php se stáhne a dostane původní jméno souboru
    const imp = new Importer(
      z,
      {
        db: t.db,
        obsah: t.app.web.obsah,
        soubory: t.app.soubory,
        presmerovani: t.app.web.presmerovani,
        dotace: t.app.web.dotace,
        deska: t.app.deska,
      },
      st,
      { aktualityOd: new Date('2026-01-01'), stranky: false, aktuality: false, menu: false, dotace: false },
    );
    await imp.spust();
    const d = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('puvodni_url', '=', `${G}/urad/uredni-deska/rozpocet-2026-2099.html`)
      .executeTakeFirstOrThrow();
    const prilohy = await t.app.deska.prilohy(d.id);
    expect(prilohy.map((p) => p.puvodni_nazev)).toEqual(['Rozpočet 2026.pdf']);
  });
});

describe('adaptér archiv (starý web z Wayback Machine)', () => {
  it('vytěží články z TopDesign stránek, sloučí výskyty, doplní detail a importuje bez duplicit', async () => {
    const { ArchivZdroj, VYTEZOVACE, datumZTextu, slovniDatum } =
      await import('../src/moduly/web/import/archiv.js');
    const { dekodujHtml, parsujCdx, waybackStahovac, waybackUrl } =
      await import('../src/moduly/web/import/wayback.js');
    expect(datumZTextu('Vložil: Obecní úřad  | 20.03.2009')).toBe('2009-03-20');
    expect(slovniDatum('19. dubna 2003 se konal')).toEqual({ datum: '2003-04-19', jenMesic: false });
    expect(slovniDatum('Červenec 2005 - turnaj')).toEqual({ datum: '2005-07-01', jenMesic: true });
    // staré kódování: windows-1250 bez deklarace i s chybnou deklarací iso-8859-1
    expect(dekodujHtml(Buffer.from([0x9e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd]))).toBe(
      'žluťoučký',
    );
    expect(dekodujHtml(Buffer.from('<meta charset="iso-8859-1">\xe8', 'latin1'))).toContain('č');
    const A = 'http://www.stara-obec.cz';
    const cdx = parsujCdx(
      [
        `20090331081240 ${A}:80/aktuality.php 200 text/html`,
        `20090331081300 ${A}/index.php?akce=in&fn=clanky_list&kat=2 200 text/html`,
        `20031012105416 ${A}/kultura.htm 200 text/html`,
        `20031012105416 ${A}/index.htm 200 text/html`,
        '<html>Temporarily unavailable</html>',
      ].join('\n'),
    );
    expect(cdx).toHaveLength(4);
    expect(cdx[0]!.url).toBe(`${A}/aktuality.php`);
    const aktuality = (titulek: string, text: string, datum: string) =>
      `<table><tr><td class="aktualne-nadpis"><img src="gif/v_odrazka_akt.gif"> ${titulek}</td></tr><tr><td class="aktualne-text">${text}</td></tr><tr><td class="aktualne_datum" align="right">Vložil: Jan Novák | ${datum}</td></tr></table>`;
    const stranky: Record<string, string> = {
      [`${A}/aktuality.php`]:
        aktuality(
          'Czech POINT',
          'Výpisy na úřadě. <a href="plakat.pdf"><b>Plakát</b></a> a <a href="kontakty.php">kontakty</a>.',
          '27.11.2008',
        ) + aktuality('Oznámení ČEZ, a.s.', '<font color="red">Bez proudu</font> 4.4.2009.', '20.03.2009'),
      [`${A}/index.php?akce=in&fn=clanky_list&kat=2`]: `<div align="right" class="clanek-datum">2008-02-22 14:51:55</div><a href="index.php?akce=in&amp;fn=clanky_view&amp;clanek=7" class="clanek-nadpis"> >> Paměti obce</a><span class="clanek-text">Začátek…</span>`,
      [`${A}/index.php?akce=in&fn=clanky_view&clanek=7`]: `<td class="clanek-nadpis">Paměti obce</td><td><p class="clanek-text">Celý text kapitoly.<br><br>Druhý odstavec</td>`,
      // statické stránky: zprávy s odrážkou, datum na začátku, rozházené odstavce šablony
      [`${A}/kultura.htm`]: `<p><img src="gif/odrazka3.gif"> Září 2005 <b>- Otevření hřiště</b>.<br>Fotky <a href="foto/a.htm">zde</a>.</p><p>Fotografie z olympiády zde.</p><p><img src="gif/odrazka3.gif"> Květen 2003 <b>- Dětská olympiáda</b>.</p><p>Fotografie z olympiády zde.</p><p><a href="index.htm">&lt;&lt; Zpět na hlavní stranu</a></p>`,
      [`${A}/index.htm`]: `<b>Aktuální informace</b><p><img src="gif/odrazka2.gif"> V rubrice Jivina byly přidány nové fotografie, podívejte se.</p><p><img src="gif/odrazka2.gif"> <b>Velikonoční teniska</b> Zveme děti na sportovní odpoledne před kulturním domem.</p> stručná charakteristika`,
    };
    const st: Stahovac = {
      stazeno: 0,
      async text() {
        throw new Error('ne');
      },
      async json() {
        throw new Error('ne');
      },
      async soubor(url) {
        stazene.push(url);
        const m = /^https:\/\/web\.archive\.org\/web\/\d{14}id_\/(.*)$/.exec(url);
        const puvodni = m?.[1] ?? url;
        if (puvodni in stranky) return { data: Buffer.from(stranky[puvodni]!), typ: 'text/html' };
        if (puvodni.endsWith('.pdf')) return { data: MALE_PDF, typ: 'application/pdf' };
        return null;
      },
    };
    const zdroj = new ArchivZdroj({
      zaklad: `${A}/`,
      stahovac: st,
      stranky: cdx,
      vytezovace: Object.values(VYTEZOVACE),
      kategorie: 'archiv',
      vynechatText: /byl[ay]? přidán/i,
    });
    const clanky = await zdroj.priprav();
    expect(clanky.map((c) => [c.datum.toISOString().slice(0, 10), c.titulek])).toEqual([
      ['2003-05-01', 'Dětská olympiáda'],
      ['2005-09-01', 'Otevření hřiště'],
      ['2008-02-22', 'Paměti obce'],
      ['2008-11-27', 'Czech POINT'],
      ['2009-03-20', 'Oznámení ČEZ, a.s.'],
    ]);
    expect(clanky[0]!.datumOdvozene).toBe('u zprávy je jen měsíc a rok');
    // odstavec patřící další zprávě z předchozí vypadl, „<< Zpět“ taky
    expect(clanky[1]!.html).not.toContain('olympiády');
    expect(clanky[1]!.html).not.toContain('&lt;');
    // detail článku: celý text místo začátku ze seznamu; jméno vkladatele se nepřebírá
    expect(clanky[2]!.html).toContain('Druhý odstavec');
    expect(clanky[2]!.url).toBe(`${A}/index.php?akce=in&fn=clanky_view&clanek=7`);
    expect(clanky.some((c) => c.html.includes('Novák'))).toBe(false);
    // novinka bez data (stránka nemá „Poslední aktualizace“) → k ručnímu posouzení; zpráva o webu vynechána
    expect(zdroj.bezData.map((b) => b.titulek)).toEqual(['Velikonoční teniska']);
    expect(waybackUrl('20090331081240', `${A}/a.pdf`)).toBe(
      `https://web.archive.org/web/20090331081240id_/${A}/a.pdf`,
    );

    // import: kategorie podle mapy, bez přesměrování, odkaz na neimportovanou stránku → text, PDF → /soubory
    await t.db
      .insertInto('web_kategorie')
      .values({ slug: 'archiv-stareho-webu', nazev: 'Archiv starého webu', poradi: 900 })
      .execute();
    const imp = () =>
      new Importer(
        zdroj,
        {
          db: t.db,
          obsah: t.app.web.obsah,
          soubory: t.app.soubory,
          presmerovani: t.app.web.presmerovani,
          dotace: t.app.web.dotace,
        },
        waybackStahovac(st, '20090331081240', (u) => u.startsWith(A)),
        {
          aktualityOd: new Date('1990-01-01'),
          stranky: false,
          menu: false,
          dotace: false,
          deska: false,
          archiv: true,
          kontrolaDuplicit: true,
          kategorieAktualit: { archiv: 'archiv-stareho-webu' },
          znameClanky: [{ titulek: 'Oznámení ČEZ', datum: new Date('2009-03-21'), zdroj: 'WordPress' }],
        },
      );
    const v = await imp().spust();
    expect(v.aktuality).toBe(4);
    expect(v.duplicity).toEqual([expect.stringContaining('Oznámení ČEZ, a.s. (2009-03-20) = Oznámení ČEZ')]);
    expect(v.presmerovani).toBe(0);
    const czech = await t.db
      .selectFrom('web_obsah')
      .innerJoin('web_kategorie', 'web_kategorie.id', 'web_obsah.kategorie_id')
      .select(['web_obsah.obsah_html', 'web_obsah.datum', 'web_kategorie.slug as kat', 'web_obsah.zdroj'])
      .where('web_obsah.titulek', '=', 'Czech POINT')
      .executeTakeFirstOrThrow();
    expect(czech.kat).toBe('archiv-stareho-webu');
    expect(czech.zdroj).toBe('import');
    expect(czech.obsah_html).toMatch(/<a href="\/soubory\/[^"]+"><strong>Plakát<\/strong><\/a>/);
    expect(czech.obsah_html).toContain(' a kontakty.');
    expect(czech.obsah_html).not.toContain('stara-obec.cz');
    expect(stazene).toContain(`https://web.archive.org/web/20090331081240id_/${A}/plakat.pdf`);
    expect(czech.datum!.toISOString().slice(0, 10)).toBe('2008-11-27');
    // podruhé nic nového
    const v2 = await imp().spust();
    expect(v2.aktuality).toBe(0);
  });
});
