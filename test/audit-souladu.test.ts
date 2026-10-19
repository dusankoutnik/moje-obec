// Opravy podle auditu souladu se zákony (19. 10. 2026): povinné informace podle vyhl. 515/2020 Sb., prohlášení
// o přístupnosti, cookies jen s formulářem, bezpečnostní hlavičky, sitemap/robots, odkaz na externí akci, import bez
// vymyšlených popisů obrázků a s hierarchií nadpisů, neveřejný archiv dokumentů jiných úřadů, nové kategorie desky.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obecZObjektu } from '../src/config/obec.js';
import { premapujPiBody } from '../src/db/migrations/0008_audit_souladu.js';
import {
  altZeZdroje,
  pocetBezPopisu,
  popiskyOdkazuSObrazkem,
  sanitizuj,
  srovnejNadpisy,
} from '../src/lib/html.js';
import { sbirkaPp, STRUKTURA_PI, vyplnPi } from '../src/moduly/deska/povinne.js';
import { odkazAkce } from '../src/moduly/web/akce-externi.js';
import { sitemapXml } from '../src/moduly/web/mapa.js';
import { CSP } from '../src/web/hlavicky.js';
import { MALE_PDF, prihlasSRoli, Prohlizec, spustTestApp, testovaciObec, type TestApp } from './pomocnici.js';

describe('povinně zveřejňované informace — příloha č. 1 vyhl. 515/2020 Sb.', () => {
  it('označení bodů přesně podle přílohy', () => {
    const n = Object.fromEntries(STRUKTURA_PI.map((b) => [b.klic, b.nazev]));
    expect(n['1']).toBe('Název');
    expect(n['4.5']).toBe('Adresa internetových stránek');
    expect(n['4.6']).toBe('Adresa podatelny');
    expect(n['4.7']).toBe('Elektronická adresa podatelny');
    expect(n['4.8']).toBe('Datová schránka');
    expect(n['7']).toBe('Plátce daně z přidané hodnoty');
    expect(n['8.1']).toBe('Seznamy hlavních dokumentů');
    expect(n['12.2']).toBe('Rozhodnutí nadřízeného orgánu o výši úhrad za poskytnutí informací');
    expect(STRUKTURA_PI.filter((b) => b.uroven === 1)).toHaveLength(14);
    expect(STRUKTURA_PI.map((b) => b.klic)).toEqual([
      ...['1', '2', '3', '4', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '5', '6', '7', '8'],
      ...['8.1', '8.2', '9', '10', '11', '11.1', '11.2', '12', '12.1', '12.2', '13', '13.1', '13.2', '14'],
    ]);
  });

  it('obsah bodů: zřizovatel a nadřízený orgán, DPH, opravné prostředky, nahlížení do předpisů, Sbírka', () => {
    const o = obecZObjektu({
      obec: {
        nazev: 'Obec Vzorov',
        kratky_nazev: 'Vzorov',
        casti: ['Vzorov'],
        adresa: { ulice: 'Vzorov 1', psc: '123 45', mesto: 'Vzorov' },
        kontakt: { datova_schranka: 'abc1234', epodatelna: 'podatelna@vzorov.cz', web: 'https://vzorov.cz' },
        nadrizeny_organ: 'Krajský úřad Vzorového kraje',
        platce_dph: false,
        dic: 'CZ00000001',
      },
    });
    const body = Object.fromEntries(
      vyplnPi(o, new Map(), { baseUrl: 'https://dev.vzorov.cz', deska: true }).map((b) => [b.klic, b.html]),
    );
    expect(body['2']).toContain('Zřizovatel');
    expect(body['2']).toContain('Krajský úřad Vzorového kraje');
    expect(body['4.1']).toContain('Sídlo');
    expect(body['4.5']).toContain('https://vzorov.cz');
    expect(body['4.7']).toContain('podatelna@vzorov.cz');
    expect(body['4.8']).toContain('abc1234');
    expect(body['7']).toContain('není plátcem daně z přidané hodnoty');
    expect(body['9']).toContain('odvolání do 15 dnů');
    expect(body['9']).toContain('/uredni-deska?kategorie=poskytnute-informace');
    expect(body['10']).toContain('Opravné prostředky proti rozhodnutím obce');
    expect(body['11.1']).toContain('k nahlédnutí');
    expect(body['11.2']).toContain('https://sbirkapp.gov.cz/vydavatel/abc1234');
    expect(sbirkaPp({ ...o, obec: { ...o.obec, sbirka_pp: 'https://sbirkapp.gov.cz/x' } })).toBe(
      'https://sbirkapp.gov.cz/x',
    );
    // plátce DPH neuveden → bod chybí (úřad doplní)
    const bez = vyplnPi(testovaciObec, new Map(), { baseUrl: 'x', deska: true }).find((b) => b.klic === '7')!;
    expect(bez.stav).toBe('chybi');
  });
});

describe('import a popisy obrázků (bez DB)', () => {
  it('alt ze zdroje: obecné a názvy souborů se zahodí', () => {
    expect(altZeZdroje('Image', 'x.jpg')).toBe('');
    expect(altZeZdroje('DSC_0012', 'DSC_0012.jpg')).toBe('');
    expect(altZeZdroje('Lapy u balaho kaaaaaaale', 'lapy-u-balaho-kaaaaaaale-1024x768.jpg')).toBe('');
    expect(altZeZdroje('Kaple sv. Anny v zimě', 'kaple.jpg')).toBe('Kaple sv. Anny v zimě');
    expect(altZeZdroje('', 'kaple.jpg')).toBe('');
  });
  it('nadpisy se nepřeskakují, h1 z obsahu je h2', () => {
    expect(srovnejNadpisy(sanitizuj('<h1>A</h1><h4>B</h4><h3>C</h3><h2>D</h2><h4>E</h4>'))).toBe(
      '<h2>A</h2><h3>B</h3><h3>C</h3><h2>D</h2><h3>E</h3>',
    );
    expect(srovnejNadpisy('<h3>X</h3>')).toBe('<h2>X</h2>');
  });
  it('počet obrázků bez popisu a přístupný název odkazu s takovým obrázkem', () => {
    const html = '<p><img src="/a" alt="" /><img src="/b" alt="Kaple" /><img src="/c" /></p>';
    expect(pocetBezPopisu(html)).toBe(2);
    expect(popiskyOdkazuSObrazkem('<a href="/s/1"><img src="/s/1?v=nahled" alt="" /></a>')).toContain(
      'aria-label="Obrázek bez popisu',
    );
    expect(popiskyOdkazuSObrazkem('<a href="/s/1"><img src="/s/1" alt="Kaple" /></a>')).not.toContain(
      'aria-label',
    );
  });
});

describe('drobnosti (bez DB)', () => {
  it('odkaz na akci: externí akce bez odkazu nevede na /akce/null', () => {
    expect(odkazAkce({ externi: true, slug: null, url: null })).toBeNull();
    expect(odkazAkce({ externi: true, slug: null, url: '/predprodej/x' })).toBe('/predprodej/x');
    expect(odkazAkce({ slug: 'den-deti' })).toBe('/akce/den-deti');
  });
  it('sitemap: absolutní adresy, bez duplicit, jen vlastní cesty', () => {
    const x = sitemapXml('https://obec.cz', [
      { url: '/' },
      { url: '/' },
      { url: 'https://cizi.cz/' },
      { url: '/aktuality/čistění', lastmod: new Date('2026-10-01T10:00:00Z') },
    ]);
    expect(x.match(/<url>/g)).toHaveLength(2);
    expect(x).toContain(
      '<loc>https://obec.cz/aktuality/%C4%8Dist%C4%9Bn%C3%AD</loc><lastmod>2026-10-01</lastmod>',
    );
  });
  it('CSP: vlastní původ, přehrávače videí, žádné inline skripty', () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(CSP).toContain('frame-src https://www.youtube-nocookie.com https://player.vimeo.com');
    expect(CSP).toContain("frame-ancestors 'self'");
  });
  it('prohlášení o přístupnosti: výchozí stav „částečně“, data se nedopočítávají', () => {
    expect(testovaciObec.pristupnost).toEqual({
      stav: 'castecne',
      vypracovano: '',
      aktualizovano: '',
      posouzeni: 'vlastním posouzením provedeným obcí',
    });
  });
});

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());

describe('s aplikací', () => {
  it('přečíslování textů úřadu u bodů 4.5–4.8 nic neztratí', async () => {
    await t.db.deleteFrom('pi_body').execute();
    await t.db
      .insertInto('pi_body')
      .values([
        { klic: '4.4', obsah_html: '<p>Tel</p>' },
        { klic: '4.5', obsah_html: '<p>Fax 1</p>' },
        { klic: '4.6', obsah_html: '<p>Web</p>' },
        { klic: '4.7', obsah_html: '<p>Podatelna</p>' },
        { klic: '4.8', obsah_html: '<p>Další adresy</p>' },
      ])
      .execute();
    await premapujPiBody(t.db as never);
    const r = Object.fromEntries(
      (await t.db.selectFrom('pi_body').select(['klic', 'obsah_html']).execute()).map((x) => [
        x.klic,
        x.obsah_html,
      ]),
    );
    expect(r).toEqual({
      '4.4': '<p>Tel</p><p>Fax 1</p>',
      '4.5': '<p>Web</p>',
      '4.7': '<p>Podatelna</p><p>Další adresy</p>',
    });
    await t.db.deleteFrom('pi_body').execute();
  });

  it('veřejné stránky bez formuláře nezakládají cookie; přihlášení a odběr ano', async () => {
    for (const url of [
      '/',
      '/uredni-deska',
      '/povinne-informace',
      '/prohlaseni-o-pristupnosti',
      '/kontakt',
    ]) {
      const r = await fetch(t.base + url, { headers: { accept: 'text/html' } });
      expect(r.status, url).toBe(200);
      expect(r.headers.getSetCookie().join(' '), url).not.toContain('mo_sezeni');
    }
    const ik = await fetch(`${t.base}/infokanal`, { headers: { accept: 'text/html' } });
    expect(ik.headers.getSetCookie().join(' ')).toContain('mo_sezeni');
  });

  it('bezpečnostní hlavičky a robots.txt se sitemap', async () => {
    const r = await fetch(t.base + '/');
    expect(r.headers.get('content-security-policy')).toBe(CSP);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    // http instalace (test) → bez HSTS; ROBOTS_NOINDEX nenastaveno → bez X-Robots-Tag
    expect(r.headers.get('strict-transport-security')).toBeNull();
    expect(r.headers.get('x-robots-tag')).toBeNull();
    const robots = await (await fetch(t.base + '/robots.txt')).text();
    expect(robots).toContain(`Sitemap: ${t.base}/sitemap.xml`);
    expect(robots).toContain('Disallow: /sprava');
  });

  it('prohlášení o přístupnosti: stav a datum z nastavení, dozor DIA, nepřístupný obsah', async () => {
    const p = await new Prohlizec(t.base).get('/prohlaseni-o-pristupnosti');
    expect(p.text).toContain('částečně v souladu');
    expect(p.text).not.toContain('plně v souladu');
    expect(p.text).toContain('Nepřístupný obsah');
    expect(p.text).toContain('Digitální a informační agentura');
    expect(p.text).toContain('§ 9 zákona č. 99/2019 Sb.');
    expect(p.text).toContain('Datum vypracování prohlášení obec doplní');
    expect(p.text).not.toContain('pristupnost@mvcr.cz');
  });

  it('GDPR: úřad nezpracovává na základě oprávněného zájmu, zpracovatelé, odkaz na cookies', async () => {
    const p = await new Prohlizec(t.base).get('/ochrana-osobnich-udaju');
    expect(p.text).toContain('čl. 6 odst. 1 písm. c) GDPR');
    expect(p.text).toContain('Příjemci a zpracovatelé');
    expect(p.text).toContain('SMS brány');
    expect(p.text).not.toContain('Právní základ: oprávněný zájem');
  });

  it('kategorie desky: pozvánky ZO nejméně 7 dní, poskytnuté informace 6 let, jiné úřady bez veřejného archivu', async () => {
    const k = await t.db.selectFrom('ud_kategorie').selectAll().execute();
    const podle = (s: string) => k.find((x) => x.slug === s)!;
    expect(podle('pozvanky-zo').min_dni).toBe(7);
    expect(podle('poskytnute-informace').min_dni).toBeGreaterThanOrEqual(2191);
    expect(podle('jine-urady').archiv_verejny).toBe(false);
    expect(podle('zamery').archiv_verejny).toBe(true);
  });

  it('sejmutý dokument jiného úřadu není ve veřejném archivu ani jeho příloha; úřad ho vidí', async () => {
    const kat = await t.db
      .selectFrom('ud_kategorie')
      .select(['id', 'slug'])
      .where('slug', 'in', ['jine-urady', 'ostatni'])
      .execute();
    const id = (s: string) => kat.find((x) => x.slug === s)!.id;
    const zaklad = { cisloJednaci: '', puvodce: '', popis: '', typRozpoctu: null, rok: null };
    const exekuce = await t.app.deska.uloz(
      null,
      {
        ...zaklad,
        nazev: 'Dražební vyhláška — povinný Jan Dlužník',
        kategorieId: id('jine-urady'),
        od: '2020-01-01',
        do: '2020-01-20',
      },
      null,
    );
    const obecni = await t.app.deska.uloz(
      null,
      {
        ...zaklad,
        nazev: 'Oznámení o svozu odpadu 2020',
        kategorieId: id('ostatni'),
        od: '2020-01-01',
        do: '2020-01-20',
      },
      null,
    );
    const pdf = await t.app.soubory.uloz({ data: MALE_PDF, nazev: 'drazba.pdf', druh: 'dokument' });
    if (!('soubor' in pdf)) throw new Error('soubor');
    await t.app.deska.pridejPrilohy(exekuce, [pdf.soubor.id]);

    const anonym = new Prohlizec(t.base);
    const archiv = await anonym.get('/uredni-deska/archiv');
    expect(archiv.text).toContain('Oznámení o svozu odpadu 2020');
    expect(archiv.text).not.toContain('Jan Dlužník');
    expect((await anonym.get(`/uredni-deska/${obecni}`)).res.status).toBe(200);
    const detail = await anonym.get(`/uredni-deska/${exekuce}`);
    expect(detail.res.status).toBe(410);
    expect(detail.text).not.toContain('Jan Dlužník');
    expect((await fetch(`${t.base}/soubory/${pdf.soubor.id}/drazba.pdf`)).status).toBe(404);
    const sitemap = await (await fetch(`${t.base}/sitemap.xml`)).text();
    expect(sitemap).not.toContain(exekuce);
    expect(sitemap).not.toContain(obecni);

    const urad = await prihlasSRoli(t, '777500001', ['deska']);
    expect((await urad.get(`/soubory/${pdf.soubor.id}/drazba.pdf`)).res.status).toBe(200);
    expect((await urad.get('/sprava/deska?stav=sejmuto')).text).toContain('Jan Dlužník');
  });

  it('sitemap.xml: stránky webu, aktuální deska, moduly', async () => {
    const r = await fetch(`${t.base}/sitemap.xml`);
    expect(r.headers.get('content-type')).toContain('application/xml');
    const x = await r.text();
    expect(x).toContain(`<loc>${t.base}/uredni-deska</loc>`);
    expect(x).toContain(`<loc>${t.base}/povinne-informace</loc>`);
    expect(x).toContain(`<loc>${t.base}/aktuality</loc>`);
  });
});
