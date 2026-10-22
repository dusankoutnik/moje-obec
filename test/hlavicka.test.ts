// Hlavička webu pro aplikace za proxy (docs/HLAVICKA-APLIKACI.md): GET /api/interni/hlavicka (tajemství, X-Forwarded-For,
// anonymní vs. přihlášený, tlačítko A jen pro role, zástupné komentáře právě jednou, __ZPET__, velikost písma z cookie,
// keš, CSRF odhlášení ze shellu patří k sezení z cookie), rámec ramec.css (podmenu, tisk, kontrast tlačítka A),
// web linkuje ramec.css i styl.css, /administrace → 301 /sprava, „Administrace“ místo „Správa“.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILA, kontrastRgb, oklchNaSrgb, type Rgb01 } from '../src/lib/oklch.js';
import { SCHEMATA } from '../src/moduly/web/schemata.js';
import { PRAZDNA_POLE } from '../src/moduly/web/obsah-pole.js';
import { csrfZ, prihlasSRoli, Prohlizec, spustTestApp, testovaciObec, type TestApp } from './pomocnici.js';

const TAJEMSTVI = 'hlavicka-test-tajemstvi-0123456789';
let t: TestApp;
// admin přihlášený v testu tlačítka A — znovu ho použije test Administrace (limit 10 kódů / 15 min na IP)
let admin: Prohlizec;

interface Shell {
  verze: string;
  html: string;
}

async function shell(dotaz: string, cookie = '', navic: Record<string, string> = {}) {
  const r = await fetch(`${t.base}/api/interni/hlavicka${dotaz ? '?' + dotaz : ''}`, {
    headers: { 'x-api-secret': TAJEMSTVI, cookie, ...navic },
  });
  const j = r.status === 200 ? ((await r.json()) as Shell) : null;
  return { r, j, html: j?.html ?? '' };
}

/** hlavička Cookie, jak by ji aplikace přeposlala z prohlížeče (sezení platformy + cookie aplikace) */
function cookieZ(p: Prohlizec) {
  return 'rez_sezeni=abc; ' + p['hlavickaCookie']();
}

const vyskyt = (html: string, co: string) => html.split(co).length - 1;
const hex = (h: string): Rgb01 => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb01;

beforeAll(async () => {
  t = await spustTestApp({
    env: {
      INTERNI_API_SECRET: TAJEMSTVI,
      APLIKACE_REZERVACE_URL: 'http://127.0.0.1:9',
      APLIKACE_EKNIHY_URL: 'http://127.0.0.1:9',
    },
    obec: { ...testovaciObec, moduly: { ...testovaciObec.moduly, rezervace: true, eknihy: true } },
  });
  // menu Moje obec s odkazy na aplikace (jako na webu obce: stránka s podřízenými odkazy)
  const obsah = t.app.web.obsah;
  const rodic = await obsah.uloz(
    null,
    'stranka',
    { ...PRAZDNA_POLE, titulek: 'Moje obec', slug: 'moje-obec', obsah_html: '<p>Služby obce online.</p>' },
    'zverejnit',
    null,
  );
  for (const [titulek, url] of [
    ['Můj účet', '/ucet'],
    ['Rezervace', '/rezervace/'],
    ['Spolujízda', '/rezervace/spolujizda'],
    ['eKnihy', '/eknihy/knihovna/'],
  ])
    await obsah.uloz(
      null,
      'odkaz',
      { ...PRAZDNA_POLE, titulek: titulek!, odkaz_url: url!, nadrazena_id: rodic },
      'zverejnit',
      null,
    );
});

afterAll(async () => {
  await t.zavri();
});

describe('GET /api/interni/hlavicka', () => {
  it('bez tajemství 401, s X-Forwarded-For 404 (volá se jen po vnitřní síti)', async () => {
    expect((await fetch(`${t.base}/api/interni/hlavicka?modul=rezervace`)).status).toBe(401);
    expect(
      (
        await fetch(`${t.base}/api/interni/hlavicka?modul=rezervace`, {
          headers: { 'x-api-secret': 'spatne' },
        })
      ).status,
    ).toBe(401);
    const { r } = await shell('modul=rezervace', '', { 'x-forwarded-for': '1.2.3.4' });
    expect(r.status).toBe(404);
  });

  it('anonymní: celá stránka bez obsahu, tři zástupné komentáře právě jednou a v pořadí, __ZPET__, jen ramec.css', async () => {
    const { r, j, html } = await shell('modul=rezervace');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.getSetCookie()).toEqual([]); // anonymnímu nevzniká sezení
    expect(j!.verze).toMatch(/^[0-9a-f]{12}$/);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="cs" class="velikost-normalni">');
    expect(html).not.toContain('<title>');
    expect(html).not.toContain('name="description"');
    expect(html).toMatch(/<link rel="stylesheet" href="\/static\/css\/ramec\.css\?v=\w+">/);
    expect(html).not.toContain('styl.css');
    expect(html).toContain('<style>'); // proměnné vzhledu (barvy, písma)
    expect(html).toMatch(/<script src="\/static\/js\/app\.js\?v=\w+" defer><\/script>/);
    expect(html).toMatch(/<script src="\/static\/js\/web\.js\?v=\w+" defer><\/script>/);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    for (const k of ['<!--HEAD-->', '<!--PODMENU-->', '<!--OBSAH-->']) expect(vyskyt(html, k)).toBe(1);
    const head = html.indexOf('<!--HEAD-->');
    const podmenu = html.indexOf('<!--PODMENU-->');
    const obsah = html.indexOf('<!--OBSAH-->');
    expect(head).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('</head>')).toBeLessThan(podmenu);
    expect(podmenu).toBeLessThan(obsah);
    // podmenu hned pod hlavním menu (za jeho </nav>), před <main>
    expect(html.slice(podmenu - 40, podmenu)).toContain('</nav>');
    expect(html).toContain(
      '<!--PODMENU-->\n<main id="obsah" tabindex="-1" class="obal aplikace"><div class="panel-hlavni"><!--OBSAH--></div></main>',
    );
    expect(html).toMatch(/<body class="web efekt-\w+ sila-\w+ je-aplikace">/);
    expect(html).toContain('class="pozadi"');
    expect(html).toContain('class="hlava"');
    expect(html).toContain('class="pilulka"');
    expect(html).toContain('class="paticka"');
    expect(html).toContain('href="/prihlaseni?zpet=__ZPET__"');
    expect(html).toContain('name="zpet" value="__ZPET__"'); // formulář velikosti písma se vrací do aplikace
    expect(html).not.toContain('menu-admin');
    expect(html).not.toContain('/odhlaseni');
    expect(html).not.toContain('class="flash');
    // patička: Administrace místo Správa
    expect(html).toContain('>Administrace</a>');
    expect(html).not.toMatch(/>Správa</);
  });

  it('Moje obec v hlavním menu je aktivní podle modulu; aktivni upřesní položku (nejdelší shoda)', async () => {
    const rez = (await shell('modul=rezervace')).html;
    expect(rez).toMatch(/<a href="\/rezervace\/" aria-current=page>Rezervace<\/a>/);
    expect(rez).toMatch(/<a href="\/rezervace\/spolujizda" >Spolujízda<\/a>/);
    expect(rez).toMatch(/<a href="\/moje-obec" class="je-aktivni"/);
    const spolu = (await shell('modul=spolujizda')).html;
    expect(spolu).toMatch(/<a href="\/rezervace\/spolujizda" aria-current=page>Spolujízda<\/a>/);
    expect(spolu).toMatch(/<a href="\/rezervace\/" >Rezervace<\/a>/);
    // cesta aplikace pod spolujízdou zvýrazní Spolujízdu, i když je modul rezervace
    const hlub = (
      await shell('modul=rezervace&aktivni=' + encodeURIComponent('/rezervace/spolujizda/nabizim?x=1'))
    ).html;
    expect(hlub).toMatch(/<a href="\/rezervace\/spolujizda" aria-current=page>/);
    expect(hlub).toMatch(/<a href="\/rezervace\/" >Rezervace<\/a>/);
    // eKnihy: položka menu vede hlouběji (/eknihy/knihovna/) než kořen modulu — přesto je aktivní
    const ek = (await shell('modul=eknihy')).html;
    expect(ek).toMatch(/<a href="\/eknihy\/knihovna\/" aria-current=page>eKnihy<\/a>/);
    // cizí adresa v aktivni se ignoruje, neznámý modul = shell bez zvýraznění
    const cizi = (await shell('modul=rezervace&aktivni=' + encodeURIComponent('//zly.cz/x'))).html;
    expect(cizi).toMatch(/<a href="\/rezervace\/" aria-current=page>/);
    const nic = (await shell('modul=neznamy')).html;
    expect(nic).toContain('<!--OBSAH-->');
    expect(nic).not.toContain('aria-current=page>Rezervace');
    // položky webu nejsou aktivní
    expect(rez).not.toMatch(/href="\/aktuality"[^>]*aria-current/);
  });

  it('velikost písma z přeposlané cookie', async () => {
    const { html } = await shell('modul=rezervace', 'mo_velikost=velke; rez_sezeni=x');
    expect(html).toContain('<html lang="cs" class="velikost-velke">');
    expect(html).toMatch(/value="velke" aria-pressed="true"/);
  });

  it('přihlášený občan: Můj účet a odhlášení s CSRF (token patří k sezení z cookie), bez tlačítka A', async () => {
    const obcan = await prihlasSRoli(t, '777300001', []);
    const { r, html } = await shell('modul=rezervace', cookieZ(obcan));
    expect(r.status).toBe(200);
    expect(html).toContain('href="/ucet"');
    expect(html).toMatch(
      /<form method="post" action="\/odhlaseni" class="inline"><input type="hidden" name="_csrf" value="[^"]+">/,
    );
    expect(html).not.toContain('menu-admin');
    expect(html).not.toContain('/prihlaseni?zpet=__ZPET__');
    expect(html).toContain('name="zpet" value="__ZPET__"'); // velikost písma se vrací do aplikace i přihlášenému
    // CSRF token ze shellu funguje při POST /odhlaseni z prohlížeče (stejné sezení, stejná doména)
    const token = csrfZ(html);
    const odhl = await obcan.post('/odhlaseni', { _csrf: token }, false);
    expect(odhl.res.status).toBeGreaterThanOrEqual(300);
    expect(odhl.res.status).toBeLessThan(400);
    const po = await shell('modul=rezervace', cookieZ(obcan));
    expect(po.html).toContain('/prihlaseni?zpet=__ZPET__');
    expect(po.html).not.toContain('/odhlaseni');
    // sezení v DB už není (odhlášení = smazání řádku)
    expect((await obcan.get('/ucet', false)).res.status).toBe(302);
  });

  it('tlačítko A (Administrace) jen pro správcovské role — v shellu i na webu', async () => {
    const A = '<a class="menu-admin" href="/sprava" title="Administrace" aria-label="Administrace" >A</a>';
    const ROLE_A = ['admin', 'spravce', 'web', 'deska', 'redaktor', 'ucetni', 'vstupne', 'kviz'];
    for (const role of ROLE_A) {
      const p = await prihlasSRoli(t, '7773001' + String(10 + ROLE_A.indexOf(role)), [role]);
      const { html } = await shell('modul=eknihy', cookieZ(p));
      expect(html, role).toContain(A);
      // mobilní menu má položku s textem
      expect(html, role).toContain('<a class="menu-admin" href="/sprava" >Administrace</a>');
      // na stránkách webu také
      const web = await p.get('/');
      expect(web.text, role).toContain(A);
      expect(vyskyt(web.text, 'class="menu-admin"'), role).toBe(2);
    }
    const anonym = await new Prohlizec(t.base).get('/');
    expect(anonym.text).not.toContain('menu-admin');
    // na stránce administrace je A označené jako aktuální
    admin = await prihlasSRoli(t, '777300200', ['admin']);
    expect((await admin.get('/sprava')).text).toContain('aria-label="Administrace" aria-current=page>A</a>');
  });

  it('keš 60 s podle modulu, uživatele a písma', async () => {
    const a = await shell('modul=rezervace&aktivni=' + encodeURIComponent('/rezervace/kes'));
    expect(a.r.headers.get('x-hlavicka-kes')).toBeNull();
    const b = await shell('modul=rezervace&aktivni=' + encodeURIComponent('/rezervace/kes'));
    expect(b.r.headers.get('x-hlavicka-kes')).toBe('1');
    expect(b.j!.verze).toBe(a.j!.verze);
    expect(b.html).toBe(a.html);
    const c = await shell(
      'modul=rezervace&aktivni=' + encodeURIComponent('/rezervace/kes'),
      'mo_velikost=extra',
    );
    expect(c.r.headers.get('x-hlavicka-kes')).toBeNull();
    expect(c.j!.verze).not.toBe(a.j!.verze);
    const d = await shell('modul=eknihy&aktivni=' + encodeURIComponent('/rezervace/kes'));
    expect(d.r.headers.get('x-hlavicka-kes')).toBeNull();
    expect(a.r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('rámec ramec.css a styl.css', () => {
  it('ramec.css: podmenu, tlačítko A, obsah aplikace, proměnné, tisk; bez stylů obsahu', async () => {
    const ramec = await (await fetch(`${t.base}/static/css/ramec.css`)).text();
    for (const s of [
      '.podmenu {',
      '.podmenu-in {',
      '.podmenu-znacka {',
      '.podmenu-seznam {',
      '.podmenu-rozbal {',
      '.podmenu-vpravo {',
      ".ma-rozbal > button[aria-expanded='true'] + .podmenu-rozbal {",
      '.podmenu-seznam > li > button[aria-current] {',
      'a.menu-admin {',
      '.obal.aplikace > .panel-hlavni {',
      '--pismo-nadpisy: var(--pismo-nadpis);',
      '--vyska-menu:',
      '.pozadi {',
      '.hlava-pas {',
      '.pilulka {',
      '.menu-mobil {',
      '.paticka {',
      '.pas-dotaci {',
      '@media print {',
      'prefers-reduced-motion: reduce',
      '@supports ((backdrop-filter',
    ])
      expect(ramec, s).toContain(s);
    // podmenu je přilepené pod plovoucím menu; na mobilu posuvný řádek
    expect(ramec).toMatch(/\.podmenu \{[^}]*position: sticky/);
    expect(ramec).toContain('top: calc(10px + var(--vyska-menu) + 8px);');
    expect(ramec).toMatch(/\.podmenu-seznam \{[^}]*overflow-x: auto/);
    // tisk skrývá celý rámec
    const tisk = ramec.slice(ramec.indexOf('@media print {'));
    for (const s of ['.pozadi,', '.hlava,', '.pilulka,', '.podmenu,', '.paticka {'])
      expect(tisk).toContain(s);
    // žádné obecné prvky obsahu (nerozbít aplikace)
    for (const s of [
      '\ntable {',
      '\ninput',
      '\nbutton {',
      '\nform {',
      '\n.karta {',
      '\n.tlacitko {',
      '\nh1',
      '\na {',
    ])
      expect(ramec, s).not.toContain(s);
    // styl.css už rámec neobsahuje (jeden zdroj)
    const styl = await (await fetch(`${t.base}/static/css/styl.css`)).text();
    for (const s of [
      '.hlava-pas {',
      '.pilulka {',
      '.paticka {',
      '.pozadi {',
      '.menu-mobil {',
      '.panel-hlavni {',
    ])
      expect(styl, s).not.toContain(s);
    expect(styl).toContain('table');
  });

  it('kontrast tlačítka A a podmenu ≥ 4,5 : 1 ve všech schématech', async () => {
    const ramec = await (await fetch(`${t.base}/static/css/ramec.css`)).text();
    const m = /var\(--menu-admin, (#[0-9a-f]{6})\)/.exec(ramec);
    expect(m).not.toBeNull();
    expect(kontrastRgb(hex(m![1]!), BILA)).toBeGreaterThanOrEqual(4.5);
    // text podmenu (--text) na bílém pruhu a aktivní položka (--primarni) na bílém i na --svetla (hover)
    expect(kontrastRgb(hex('#1a1a1a'), BILA)).toBeGreaterThanOrEqual(4.5);
    for (const s of SCHEMATA) {
      expect(kontrastRgb(oklchNaSrgb(s.primarni), BILA), s.id).toBeGreaterThanOrEqual(4.5);
      expect(kontrastRgb(oklchNaSrgb(s.primarni), oklchNaSrgb(s.svetla)), s.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('web linkuje ramec.css i styl.css (v tomto pořadí)', async () => {
    const web = (await new Prohlizec(t.base).get('/')).text;
    const ramec = web.indexOf('/static/css/ramec.css?v=');
    const styl = web.indexOf('/static/css/styl.css?v=');
    expect(ramec).toBeGreaterThan(0);
    expect(styl).toBeGreaterThan(ramec);
    expect(web).not.toContain('<!--HEAD-->');
    expect(web).not.toContain('je-aplikace');
  });
});

describe('Administrace místo Správa', () => {
  it('/administrace* → 301 /sprava*', async () => {
    const r = await fetch(`${t.base}/administrace`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/sprava');
    const r2 = await fetch(`${t.base}/administrace/web/stranky?x=1`, { redirect: 'manual' });
    expect(r2.status).toBe(301);
    expect(r2.headers.get('location')).toBe('/sprava/web/stranky?x=1');
  });

  it('nadpisy, patička a drobky říkají Administrace', async () => {
    const s = await admin.get('/sprava');
    expect(s.text).toContain('<h1>Administrace</h1>');
    expect(s.text).toContain('<title>Administrace — Obec Testov</title>');
    expect((await admin.get('/sprava/moduly')).text).toContain('← Administrace</a>');
    expect(s.text).not.toMatch(/>Správa</);
  });
});
