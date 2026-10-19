// Vzhled webu: schémata a písma ve správě, náhled jen pro správce, vrácení zpět, velikost písma návštěvníka
// (cookie, bez JS), fotky pozadí a režimy, ikony ze znaku, písma z vlastního serveru, statistiky v úvodu.
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sestavIco } from '../src/web/ikony.js';
import { csrfZ, postSoubory, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
let spr: Prohlizec;
beforeAll(async () => {
  t = await spustTestApp();
  spr = await prihlasSRoli(t, '777600001', ['spravce']);
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const foto = (barva: string, w = 1600, h = 900) =>
  sharp({ create: { width: w, height: h, channels: 3, background: barva } })
    .jpeg()
    .toBuffer();
const znak = () =>
  sharp({ create: { width: 200, height: 240, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 1 } } })
    .png()
    .toBuffer();

async function ulozVzhled(
  pole: Record<string, string | string[]>,
  soubory: Parameters<typeof postSoubory>[3] = [],
) {
  const f = await spr.get('/sprava/web/vzhled');
  return postSoubory(spr, '/sprava/web/vzhled', { _csrf: csrfZ(f.text), akce: 'ulozit', ...pole }, soubory);
}

describe('vzhled', () => {
  it('správa ukazuje miniatury schémat a ukázky všech písem', async () => {
    const r = await spr.get('/sprava/web/vzhled');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('value="vlastiborice"');
    expect(r.text).toContain('value="outdoor"');
    expect(r.text).toContain('Příliš žluťoučký kůň');
    expect(r.text).toContain("font-family:'Atkinson Hyperlegible'");
    expect(r.text).toContain("font-family:'Ubuntu'");
  });

  it('schéma, písmo a velikost se použijí; předchozí vzhled jde vrátit', async () => {
    await ulozVzhled({
      schema: 'uredni-modra',
      pismo: 'citelne',
      velikost: 'velke',
      pozadi_rezim: 'stridani',
    });
    const web = await new Prohlizec(t.base).get('/');
    expect(web.text).toContain('class="velikost-velke"');
    expect(web.text).toMatch(/--primarni:oklch\(0\.46 0\.13 255\)/);
    expect(web.text).toContain("--pismo:'Atkinson Hyperlegible'");
    expect(web.text).toContain(
      '/static/fonty/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-ext-700-normal.woff2',
    );
    await ulozVzhled({ schema: 'vinova' });
    expect((await new Prohlizec(t.base).get('/')).text).toMatch(/--primarni:oklch\(0\.44 0\.15 15\)/);
    const f = await spr.get('/sprava/web/vzhled');
    const zpet = await spr.post('/sprava/web/vzhled/zpet', { _csrf: csrfZ(f.text) });
    expect(zpet.text).toContain('Vrátili jsme předchozí vzhled');
    expect((await new Prohlizec(t.base).get('/')).text).toMatch(/--primarni:oklch\(0\.46 0\.13 255\)/);
  });

  it('náhled vidí jen správce v sezení; ostatní dál původní vzhled; Použít ho uloží', async () => {
    const f = await spr.get('/sprava/web/vzhled');
    const nahled = await postSoubory(
      spr,
      '/sprava/web/vzhled',
      { _csrf: csrfZ(f.text), akce: 'nahled', schema: 'lesni' },
      [],
    );
    expect(nahled.url).toMatch(/\/$/);
    expect(nahled.text).toContain('NÁHLED VZHLEDU');
    expect(nahled.text).toMatch(/--primarni:oklch\(0\.4 0\.08 165\)/);
    const host = await new Prohlizec(t.base).get('/');
    expect(host.text).not.toContain('NÁHLED VZHLEDU');
    expect(host.text).not.toMatch(/--primarni:oklch\(0\.4 0\.08 165\)/);
    await spr.post('/sprava/web/vzhled/nahled-pouzit', { _csrf: csrfZ(nahled.text) });
    expect((await new Prohlizec(t.base).get('/')).text).toMatch(/--primarni:oklch\(0\.4 0\.08 165\)/);
  });

  it('velikost písma si návštěvník přepne bez JS (cookie), správou nastavená je jen výchozí', async () => {
    const p = new Prohlizec(t.base);
    const r = await p.get('/velikost?v=extra&zpet=/kontakt', false);
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get('location')).toBe('/kontakt');
    expect(r.res.headers.get('set-cookie')).toContain('mo_velikost=extra');
    const stranka = await p.get('/velikost?v=extra&zpet=/kontakt');
    expect(stranka.text).toContain('class="velikost-extra"');
    expect(stranka.text).toMatch(/value="extra" aria-pressed="true"/);
    expect((await p.get('/velikost?v=x&zpet=https://zlo.cz', false)).res.headers.get('location')).toBe('/');
  });

  it('fotky pozadí: víc najednou, režim střídání pošle seznam, pevná vybranou', async () => {
    await ulozVzhled({ pozadi_rezim: 'stridani' }, [
      { pole: 'pozadi', nazev: 'a.jpg', data: await foto('#336633') },
      { pole: 'pozadi', nazev: 'b.jpg', data: await foto('#663333') },
    ]);
    const v = await t.app.web.vzhled.nacti();
    expect(v.pozadi).toHaveLength(2);
    const web = await new Prohlizec(t.base).get('/');
    expect(web.text).toMatch(/class="pozadi" aria-hidden="true" data-fotky="\[/);
    expect(web.text).toMatch(/pozadi-vrstva viditelna" style="background-image:url\('\/soubory\//);
    const druha = v.ulozeno.pozadi_ids![1]!;
    await ulozVzhled({ pozadi_rezim: 'pevne', pozadi_pevne: druha });
    for (let i = 0; i < 3; i++) {
      const w = await new Prohlizec(t.base).get('/');
      expect(w.text).toContain(`url('/soubory/${druha}/`);
      expect(w.text).not.toContain('data-fotky');
    }
  });

  it('ikony se generují ze znaku; /favicon.ico je ICO, ne přesměrování', async () => {
    const pred = await fetch(`${t.base}/favicon.ico`);
    expect(pred.status).toBe(200);
    expect(pred.headers.get('content-type')).toBe('image/x-icon');
    await ulozVzhled({}, [{ pole: 'znak', nazev: 'znak.png', data: await znak() }]);
    const ico = Buffer.from(await (await fetch(`${t.base}/favicon.ico`)).arrayBuffer());
    expect(ico.readUInt16LE(2)).toBe(1); // typ ICO
    expect(ico.readUInt16LE(4)).toBe(3); // 16, 32, 48
    const p180 = Buffer.from(await (await fetch(`${t.base}/apple-touch-icon.png`)).arrayBuffer());
    const meta = await sharp(p180).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([180, 180, true]);
    const stred = await sharp(p180).extract({ left: 88, top: 88, width: 1, height: 1 }).raw().toBuffer();
    expect(stred[0]).toBeGreaterThan(150); // červený znak uprostřed
    const roh = await sharp(p180).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(roh[3]).toBe(0); // průhledný okraj
    const manifest = await (await fetch(`${t.base}/manifest.webmanifest`)).json();
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
    expect(sestavIco([{ velikost: 16, png: Buffer.from('x') }]).length).toBe(6 + 16 + 1);
  });

  it('písma se vydávají z vlastního serveru, jiné soubory z node_modules ne', async () => {
    const ok = await fetch(`${t.base}/static/fonty/ubuntu/files/ubuntu-latin-ext-400-normal.woff2`);
    expect(ok.status).toBe(200);
    expect((await fetch(`${t.base}/static/fonty/ubuntu/package.json`)).status).toBe(404);
  });

  it('titulka: hero se statistikami (jen agregáty), reduced-motion v CSS', async () => {
    const web = await new Prohlizec(t.base).get('/');
    expect(web.text).toContain('class="statistiky');
    expect(web.text).toContain('dokumentů na úřední desce');
    expect(web.text).toMatch(/data-cislo="\d+"/);
    const css = await (await fetch(`${t.base}/static/css/styl.css`)).text();
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('@supports ((backdrop-filter');
  });

  it('vlastní kombinace písem: tělo, nadpisy a titulek zvlášť; neplatné volby se ignorují', async () => {
    await ulozVzhled({
      pismo: 'vlastni',
      pismo_telo: 'atkinson',
      pismo_nadpis: 'merriweather',
      pismo_titulek: 'rubik-dirt',
    });
    let web = await new Prohlizec(t.base).get('/');
    expect(web.text).toContain("--pismo:'Atkinson Hyperlegible'");
    expect(web.text).toContain("--pismo-nadpis:'Merriweather'");
    expect(web.text).toContain("--pismo-display:'Rubik Dirt'");
    expect(web.text).toContain('/static/fonty/rubik-dirt/files/rubik-dirt-latin-ext-400-normal.woff2');
    const f = await spr.get('/sprava/web/vzhled');
    expect(f.text).toMatch(/name="pismo" value="vlastni"[^>]*checked/);
    expect(f.text).toMatch(/<option value="merriweather"[^>]*selected/);
    // ozdobné písmo nesmí být písmem textu → vlastní kombinace se neuloží, zůstává předchozí
    await ulozVzhled({
      pismo: 'vlastni',
      pismo_telo: 'rubik-dirt',
      pismo_nadpis: 'inter',
      pismo_titulek: 'inter',
    });
    web = await new Prohlizec(t.base).get('/');
    expect(web.text).toContain("--pismo:'Atkinson Hyperlegible'");
    // hotová dvojice dál funguje
    await ulozVzhled({ pismo: 'nunito' });
    expect((await new Prohlizec(t.base).get('/')).text).toContain("--pismo:'Nunito'");
  });

  it('název obce jde upravit a psát verzálkami nebo kapitálkami', async () => {
    await ulozVzhled({ nazev: 'Obec <Vlastibořice>', nazev_styl: 'kapitalky' });
    let web = await new Prohlizec(t.base).get('/');
    expect(web.text).toMatch(/class="hero-nazev[^"]*nazev-kapitalky"[^>]*>Obec &lt;Vlastibořice&gt;</);
    expect(web.text).toMatch(/class="znacka-nazev nazev-kapitalky">Obec &lt;Vlastibořice&gt;</);
    await ulozVzhled({ nazev: '', nazev_styl: 'nesmysl' });
    web = await new Prohlizec(t.base).get('/');
    expect(web.text).toMatch(/class="znacka-nazev nazev-kapitalky">[^<&]+</); // prázdný název = výchozí z obec.yml, neplatný styl se ignoruje
    await ulozVzhled({ nazev_styl: 'verzalky' });
    expect((await new Prohlizec(t.base).get('/')).text).toContain('nazev-verzalky');
    const css = await (await fetch(`${t.base}/static/css/styl.css`)).text();
    expect(css).toContain('font-variant-caps: small-caps');
  });
});
