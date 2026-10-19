// Obecní web: stránky a menu, koncepty a revize, editor (sanitizace, alt), aktuality, galerie, dokumenty,
// dotace s pásem log, přesměrování, hledání, vzhled, práva, napojení infokanálu.
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kontrast, paleta } from '../src/lib/barvy.js';
import { upozorniNaKonecDotaci } from '../src/moduly/web/udrzba.js';
import { navrhAlt } from '../src/moduly/web/sprava.js';
import { PresmerovaniSluzba } from '../src/moduly/web/dalsi.js';
import {
  csrfZ,
  postSoubory,
  prihlasSRoli,
  prihlasTelefonem,
  Prohlizec,
  spustTestApp,
  type TestApp,
} from './pomocnici.js';

let t: TestApp;
let red: Prohlizec;
let spr: Prohlizec;
beforeAll(async () => {
  t = await spustTestApp();
  red = await prihlasSRoli(t, '777500001', ['web']);
  spr = await prihlasSRoli(t, '777500002', ['spravce']);
  await t.db
    .updateTable('uzivatele')
    .set({ email: 'spravce@testov.cz' })
    .where('telefon', '=', '+420777500002')
    .execute();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const png = (barva = '#336699', w = 300, h = 120) =>
  sharp({ create: { width: w, height: h, channels: 4, background: barva } })
    .png()
    .toBuffer();

async function uloz(
  p: Prohlizec,
  url: string,
  pole: Record<string, string>,
  soubory: Parameters<typeof postSoubory>[3] = [],
) {
  const form = await p.get(url);
  const action = url.startsWith('/sprava/web/novy') ? '/sprava/web/novy' : url;
  return postSoubory(p, action, { _csrf: csrfZ(form.text), ...pole }, soubory);
}
const verejne = () => new Prohlizec(t.base);
async function obsah(titulek: string) {
  return t.db.selectFrom('web_obsah').selectAll().where('titulek', '=', titulek).executeTakeFirstOrThrow();
}

describe('pomocné funkce', () => {
  it('paleta ztmaví světlou barvu na kontrast 4,5:1', () => {
    const p = paleta('#7fd37f');
    expect(p.upravena).toBe(true);
    expect(kontrast(p.primarni, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(paleta('#1b5e20').upravena).toBe(false);
  });
  it('návrh alt textu jen z rozumného názvu souboru', () => {
    expect(navrhAlt('nove-hriste_2024.jpg')).toBe('Nove hriste 2024');
    expect(navrhAlt('IMG_2034.JPG')).toBe('');
    expect(navrhAlt('DSC01234.jpg')).toBe('');
    expect(navrhAlt('dji-0028-150x150.jpg')).toBe('');
    expect(navrhAlt('kaple-sv-anny-1024x768.jpg')).toBe('Kaple sv anny');
  });
  it('normalizace staré adresy', () => {
    expect(PresmerovaniSluzba.normalizuj('https://vlastiborice.cz/2024/05/Clanek/')).toBe('/2024/05/clanek');
    expect(PresmerovaniSluzba.normalizuj('/?p=123')).toBe('/?p=123');
  });
});

describe('titulní stránka a stránky', () => {
  it('titulka: výchozí menu, rychlé odkazy, skip link, čeština', async () => {
    const r = await verejne().get('/');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('lang="cs"');
    expect(r.text).toContain('href="#obsah"');
    expect(r.text).toContain('href="/aktuality"');
    expect(r.text).toContain('href="/uredni-deska"');
    expect(r.text).toContain('class="rychle"');
  });

  it('stránka s podstránkou: koncept není vidět, po zveřejnění je v menu i na adrese', async () => {
    const k = await uloz(red, '/sprava/web/novy?typ=stranka', {
      typ: 'stranka',
      titulek: 'Obecní úřad',
      obsah_html: '<p>Úřad obce.</p>',
      v_menu: 'ano',
      akce: 'koncept',
    });
    expect(k.text).toContain('Uloženo jako rozpracované');
    expect((await verejne().get('/obecni-urad')).res.status).toBe(404);
    const o = await obsah('Obecní úřad');
    const z = await uloz(red, `/sprava/web/obsah/${o.id}`, {
      titulek: 'Obecní úřad',
      obsah_html: '<p>Úřad obce.</p>',
      v_menu: 'ano',
      akce: 'zverejnit',
    });
    expect(z.text).toContain('Hotovo, stránka je na webu.');
    expect(z.text).toContain('href="/obecni-urad"');
    await uloz(red, `/sprava/web/novy?typ=stranka&nadrazena=${o.id}`, {
      typ: 'stranka',
      titulek: 'Úřední hodiny',
      nadrazena_id: o.id,
      obsah_html: '<p>Po 8–12</p>',
      v_menu: 'ano',
      akce: 'zverejnit',
    });
    const pod = await verejne().get('/obecni-urad/uredni-hodiny');
    expect(pod.res.status).toBe(200);
    expect(pod.text).toContain('Po 8–12');
    expect(pod.text).toMatch(/aria-current="?page/);
    // stará cesta bez rodiče → přesměrování na kanonickou
    const kratka = await verejne().get('/uredni-hodiny', false);
    expect(kratka.res.status).toBe(301);
    expect(kratka.res.headers.get('location')).toBe('/obecni-urad/uredni-hodiny');
    const titulka = await verejne().get('/');
    expect(titulka.text).toContain('href="/obecni-urad/uredni-hodiny"');
  });

  it('pořadí v menu jde měnit šipkami', async () => {
    const strom = await red.get('/sprava/web/stranky');
    const o = await obsah('Obecní úřad');
    await red.post(`/sprava/web/stranky/${o.id}/posun`, { _csrf: csrfZ(strom.text), smer: 'nahoru' });
    const menu = await t.app.web.obsah.menu();
    const i = menu.findIndex((m) => m.titulek === 'Obecní úřad');
    expect(i).toBeLessThan(menu.length - 1);
  });

  it('úprava zveřejněné stránky jde do konceptu; web se mění až po zveřejnění; revize jde obnovit', async () => {
    const o = await obsah('Obecní úřad');
    await uloz(red, `/sprava/web/obsah/${o.id}`, {
      titulek: 'Obecní úřad',
      obsah_html: '<p>Nový text úřadu.</p>',
      v_menu: 'ano',
      akce: 'koncept',
    });
    expect((await verejne().get('/obecni-urad')).text).toContain('Úřad obce.');
    const editor = await red.get(`/sprava/web/obsah/${o.id}`);
    expect(editor.text).toContain('Máte rozpracované změny');
    expect(editor.text).toContain('Nový text úřadu.');
    await postSoubory(
      red,
      `/sprava/web/obsah/${o.id}`,
      {
        _csrf: csrfZ(editor.text),
        titulek: 'Obecní úřad',
        obsah_html: '<p>Nový text úřadu.</p>',
        v_menu: 'ano',
        akce: 'zverejnit',
      },
      [],
    );
    expect((await verejne().get('/obecni-urad')).text).toContain('Nový text úřadu.');
    const revize = await t.app.web.obsah.revize(o.id);
    expect(revize.length).toBeGreaterThanOrEqual(3);
    const prvni = revize.at(-1)!;
    const stranka = await red.get(`/sprava/web/obsah/${o.id}/revize`);
    const po = await red.post(`/sprava/web/obsah/${o.id}/revize/${prvni.id}`, { _csrf: csrfZ(stranka.text) });
    expect(po.text).toContain('Starší verze je načtená');
    expect(po.text).toContain('Úřad obce.');
    expect((await verejne().get('/obecni-urad')).text).toContain('Nový text úřadu.'); // web zatím beze změny
  });
});

describe('editor', () => {
  it('HTML se sanitizuje, obrázek bez popisu nejde zveřejnit (koncept ano)', async () => {
    const zle =
      '<h1>Nadpis</h1><p style="color:red" onclick="x()">Ahoj<script>alert(1)</script></p><img src="/soubory/x/y.jpg">';
    const r = await uloz(red, '/sprava/web/novy?typ=aktualita', {
      typ: 'aktualita',
      titulek: 'Test sanitizace',
      obsah_html: zle,
      akce: 'zverejnit',
    });
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('U obrázků chybí popis');
    const k = await uloz(red, '/sprava/web/novy?typ=aktualita', {
      typ: 'aktualita',
      titulek: 'Test sanitizace',
      obsah_html: zle,
      akce: 'koncept',
    });
    expect(k.text).toContain('Uloženo jako rozpracované');
    const o = await obsah('Test sanitizace');
    expect(o.obsah_html).not.toContain('script');
    expect(o.obsah_html).not.toContain('style=');
    expect(o.obsah_html).not.toContain('onclick');
    expect(o.obsah_html).toContain('<h2>Nadpis</h2>');
  });

  it('automatické ukládání: JSON s CSRF v hlavičce; bez tokenu 403', async () => {
    const strana = await red.get('/sprava/web/novy?typ=aktualita');
    const csrf = csrfZ(strana.text);
    const cookie = (red as unknown as { hlavickaCookie(): string }).hlavickaCookie();
    const bez = await fetch(`${t.base}/sprava/web/obsah/novy/autosave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ typ: 'aktualita', titulek: 'Autosave' }),
    });
    expect(bez.status).toBe(403);
    const r = await fetch(`${t.base}/sprava/web/obsah/novy/autosave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ typ: 'aktualita', titulek: 'Rozepsaná zpráva', obsah_html: '<p>text</p>' }),
    });
    const j = (await r.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    const o = await t.app.web.obsah.podleId(j.id);
    expect(o?.stav).toBe('koncept');
    expect(o?.titulek).toBe('Rozepsaná zpráva');
  });

  it('náhled vykreslí neuložený text s pruhem NÁHLED a nic neuloží', async () => {
    const strana = await red.get('/sprava/web/novy?typ=aktualita');
    const r = await postSoubory(
      red,
      '/sprava/web/nahled',
      { _csrf: csrfZ(strana.text), typ: 'aktualita', titulek: 'Jen náhled', obsah_html: '<p>Zkouška</p>' },
      [],
    );
    expect(r.text).toContain('NÁHLED');
    expect(r.text).toContain('Zkouška');
    expect(r.text).toContain('noindex');
    expect(
      await t.db.selectFrom('web_obsah').select('id').where('titulek', '=', 'Jen náhled').executeTakeFirst(),
    ).toBeUndefined();
  });

  it('nahrání obrázku z editoru vrací URL a návrh popisu', async () => {
    const strana = await red.get('/sprava/web/novy?typ=aktualita');
    const r = await postSoubory(
      red,
      '/sprava/web/obrazek',
      { _csrf: csrfZ(strana.text) },
      [{ pole: 'obrazek', nazev: 'nova-lavicka.png', data: await png() }],
      false,
    );
    const j = JSON.parse(r.text) as { url: string; navrhAlt: string };
    expect(j.url).toMatch(/^\/soubory\//);
    expect(j.navrhAlt).toBe('Nova lavicka');
  });
});

describe('aktuality, akce, koš', () => {
  it('aktualita s obrázkem je na titulce, v přehledu a v RSS', async () => {
    const r = await uloz(
      red,
      '/sprava/web/novy?typ=aktualita',
      {
        typ: 'aktualita',
        titulek: 'Svoz odpadu',
        perex: 'Mění se termín svozu.',
        obsah_html: '<p>Podrobnosti.</p>',
        obrazek_alt: 'Popelnice před obecním úřadem',
        akce: 'zverejnit',
      },
      [{ pole: 'obrazek', nazev: 'popelnice.png', data: await png('#88aa44', 800, 450) }],
    );
    expect(r.text).toContain('Hotovo, aktualita je na webu.');
    expect(r.text).toContain('Zobrazit →');
    const titulka = await verejne().get('/');
    expect(titulka.text).toContain('Svoz odpadu');
    expect(titulka.text).toContain('alt="Popelnice před obecním úřadem"');
    expect((await verejne().get('/aktuality')).text).toContain('Mění se termín svozu.');
    expect((await verejne().get('/aktuality/svoz-odpadu')).res.status).toBe(200);
    expect(await (await fetch(`${t.base}/aktuality/rss.xml`)).text()).toContain('Svoz odpadu');
  });

  it('úvodní obrázek bez popisu se nezveřejní', async () => {
    const r = await uloz(
      red,
      '/sprava/web/novy?typ=aktualita',
      { typ: 'aktualita', titulek: 'Bez popisu', akce: 'zverejnit' },
      [{ pole: 'obrazek', nazev: 'x.png', data: await png() }],
    );
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('chybí popis');
  });

  it('akce v kalendáři', async () => {
    const zitra = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await uloz(red, '/sprava/web/novy?typ=akce', {
      typ: 'akce',
      titulek: 'Pouťová zábava',
      datum_od: zitra,
      cas_od: '19:00',
      misto: 'Kulturní dům',
      akce: 'zverejnit',
    });
    const akce = await verejne().get('/akce');
    expect(akce.text).toContain('Pouťová zábava');
    expect(akce.text).toContain('Kulturní dům');
    expect((await verejne().get('/')).text).toContain('Pouťová zábava');
  });

  it('smazání = koš (potvrzení i bez JS), obnovení vrátí na web', async () => {
    const o = await obsah('Svoz odpadu');
    const potvrzeni = await red.get(`/sprava/web/obsah/${o.id}/smazat`);
    expect(potvrzeni.text).toContain('Opravdu smazat');
    await red.post(`/sprava/web/obsah/${o.id}/smazat`, { _csrf: csrfZ(potvrzeni.text) });
    expect((await verejne().get('/aktuality/svoz-odpadu')).res.status).toBe(404);
    const kos = await red.get('/sprava/web/kos');
    expect(kos.text).toContain('Svoz odpadu');
    await red.post(`/sprava/web/obsah/${o.id}/obnovit`, { _csrf: csrfZ(kos.text) });
    expect((await verejne().get('/aktuality/svoz-odpadu')).res.status).toBe(200);
  });
});

describe('galerie, dokumenty', () => {
  it('galerie: víc fotek najednou, předvyplněné popisy, zveřejnění', async () => {
    const seznam = await red.get('/sprava/web/galerie');
    const r = await postSoubory(
      red,
      '/sprava/web/galerie',
      { _csrf: csrfZ(seznam.text), nazev: 'Dětský den', datum: '2026-06-01' },
      [
        { pole: 'fotky', nazev: 'a.png', data: await png('#aa3333') },
        { pole: 'fotky', nazev: 'b.png', data: await png('#33aa33') },
      ],
    );
    expect(r.text).toContain('nahráno fotek: 2');
    expect(r.text).toContain('Dětský den — fotografie 1');
    const g = await t.db
      .selectFrom('web_galerie')
      .selectAll()
      .where('nazev', '=', 'Dětský den')
      .executeTakeFirstOrThrow();
    await red.post(`/sprava/web/galerie/${g.id}`, {
      _csrf: csrfZ(r.text),
      nazev: 'Dětský den',
      datum: '2026-06-01',
      akce: 'zverejnit',
    });
    const pub = await verejne().get(`/galerie/${g.slug}`);
    expect(pub.res.status).toBe(200);
    expect(pub.text).toContain('alt="Dětský den — fotografie 2"');
  });

  it('dokument ke stažení', async () => {
    const s = await red.get('/sprava/web/dokumenty');
    await postSoubory(
      red,
      '/sprava/web/dokumenty',
      { _csrf: csrfZ(s.text), nazev: 'Žádost o kácení', skupina: 'Formuláře' },
      [{ pole: 'soubor', nazev: 'kaceni.pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') }],
    );
    const pub = await verejne().get('/dokumenty');
    expect(pub.text).toContain('Žádost o kácení');
    expect(pub.text).toContain('Formuláře');
  });
});

describe('dotace', () => {
  it('průvodce: projekt → loga (i SVG převedené na PNG) → zobrazení; pás na titulce, patička, konec, upozornění', async () => {
    const k1 = await red.get('/sprava/web/dotace/nova');
    const k2 = await red.post('/sprava/web/dotace/nova', {
      _csrf: csrfZ(k1.text),
      projekt: 'Obnova hřiště',
      poskytovatel: 'Liberecký kraj',
      text: 'Projekt byl spolufinancován z rozpočtu Libereckého kraje.',
    });
    expect(k2.url).toContain('/loga');
    const d = await t.db
      .selectFrom('web_dotace')
      .selectAll()
      .where('projekt', '=', 'Obnova hřiště')
      .executeTakeFirstOrThrow();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><script>alert(1)</script><rect width="200" height="80" fill="#0055aa"/></svg>',
    );
    const k2b = await postSoubory(
      red,
      `/sprava/web/dotace/${d.id}/loga`,
      { _csrf: csrfZ(k2.text), akce: 'nahrat' },
      [
        { pole: 'loga', nazev: 'kraj.svg', data: svg, typ: 'image/svg+xml' },
        { pole: 'loga', nazev: 'eu-logo.png', data: await png('#003399', 600, 200) },
      ],
    );
    expect(k2b.text).toContain('Náhled pásu log');
    const loga = await t.app.web.dotace.loga(d.id);
    expect(loga).toHaveLength(2);
    const s = await t.app.soubory.podleId(loga[0]!.id);
    expect(s?.mime).toBe('image/png');
    const k3 = await red.post(`/sprava/web/dotace/${d.id}/loga`, { _csrf: csrfZ(k2b.text), akce: 'dal' });
    expect(k3.url).toContain('/zobrazeni');
    const dnes = new Date().toISOString().slice(0, 10);
    const za10 = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const hotovo = await red.post(`/sprava/web/dotace/${d.id}/zobrazeni`, {
      _csrf: csrfZ(k3.text),
      zobrazit_od: dnes,
      zobrazit_do: za10,
      v_paticce: 'ano',
      poradi: '1',
    });
    expect(hotovo.text).toContain('logo je na webu');
    const titulka = await verejne().get('/');
    expect(titulka.text).toContain('class="pas-dotaci"');
    expect(titulka.text).toContain(`href="/dotace/${d.id}"`);
    expect((await verejne().get('/aktuality')).text).toContain('pas-dotaci maly');
    expect((await verejne().get(`/dotace/${d.id}`)).text).toContain('Libereckého kraje');
    // upozornění správcům měsíc před koncem (jen jednou)
    const pred = t.mail.odeslane.length;
    expect(await upozorniNaKonecDotaci(t.app)).toBe(1);
    expect(
      t.mail.odeslane
        .slice(pred)
        .some((m) => m.komu === 'spravce@testov.cz' && m.text.includes('Obnova hřiště')),
    ).toBe(true);
    expect(await upozorniNaKonecDotaci(t.app)).toBe(0);
    // po skončení se samo skryje
    await t.db
      .updateTable('web_dotace')
      .set({ zobrazit_do: '2020-01-01', zobrazit_od: '2019-01-01' })
      .where('id', '=', d.id)
      .execute();
    expect((await verejne().get('/')).text).not.toContain(`/dotace/${d.id}`);
  });
});

describe('přesměrování, hledání, vzhled, práva, infokanál', () => {
  it('stará adresa → 301 na novou a počítá použití', async () => {
    await t.app.web.presmerovani.pridej(
      'https://stary-web.cz/2024/05/svoz-odpadu/',
      '/aktuality/svoz-odpadu',
    );
    const r = await verejne().get('/2024/05/svoz-odpadu/', false);
    expect(r.res.status).toBe(301);
    expect(r.res.headers.get('location')).toBe('/aktuality/svoz-odpadu');
    const z = await t.db.selectFrom('web_presmerovani').select('pocet').executeTakeFirstOrThrow();
    expect(z.pocet).toBe(1);
  });

  it('hledání bez diakritiky najde stránku i dokument úřední desky', async () => {
    const r = await verejne().get('/hledat?q=urad%20obce');
    expect(r.text).toContain('Obecní úřad');
    await t.app.deska.uloz(
      null,
      {
        nazev: 'Oznámení o uzavírce silnice',
        kategorieId: 1,
        cisloJednaci: '',
        puvodce: '',
        popis: '',
        od: new Date().toISOString().slice(0, 10),
        do: null,
        typRozpoctu: null,
        rok: null,
      },
      null,
    );
    const d = await verejne().get('/hledat?q=uzavirka');
    expect(d.text).toContain('Oznámení o uzavírce silnice');
  });

  it('vzhled: příliš světlá barva se ztmaví a propíše do CSS', async () => {
    const f = await spr.get('/sprava/web/vzhled');
    const r = await postSoubory(
      spr,
      '/sprava/web/vzhled',
      { _csrf: csrfZ(f.text), barva: '#9bd19b', motto: 'Obec pod lesem' },
      [{ pole: 'znak', nazev: 'znak.png', data: await png('#cc0000', 200, 240) }],
    );
    expect(r.text).toContain('ztmavili');
    const titulka = await verejne().get('/');
    const barva = /--zelena:(#[0-9a-f]{6})/.exec(titulka.text)![1]!;
    expect(kontrast(barva, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(titulka.text).toContain('Obec pod lesem');
    expect(titulka.text).toMatch(/class="znak" src="\/soubory\/[0-9a-f-]+\/foto\.png"/);
    expect((await red.get('/sprava/web/vzhled')).res.status).toBe(403);
  });

  it('občan do správy webu nesmí', async () => {
    const o = new Prohlizec(t.base);
    await prihlasTelefonem(o, '777500099');
    expect((await o.get('/sprava/web')).res.status).toBe(403);
    expect((await o.get('/sprava/web/novy?typ=aktualita')).res.status).toBe(403);
  });

  it('hlášení infokanálu s článkem vytvoří aktualitu', async () => {
    // redaktor webu hlášení posílat nesmí (role „redaktor“ = hlášení) — posílá správce
    expect((await red.get('/infokanal/sprava/nove')).res.status).toBe(403);
    const f = await spr.get('/infokanal/sprava/nove');
    const kat = (await t.app.infokanal.kategorie()).find((k) => k.slug === 'hlaseni')!;
    await spr.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(f.text),
      kategorie_id: String(kat.id),
      cil: 'vse',
      email_predmet: 'Uzavírka',
      email_text: 'Silnice bude uzavřena.',
      clanek_titulek: 'Uzavírka silnice v pondělí',
      clanek_text: 'Silnice bude v pondělí uzavřena.\n\nObjížďka vede přes Jivinu.',
    });
    const a = await obsah('Uzavírka silnice v pondělí');
    expect(a.zdroj).toBe('infokanal');
    expect(a.obsah_html).toContain('<p>Objížďka vede přes Jivinu.</p>');
    expect((await verejne().get('/aktuality')).text).toContain('Uzavírka silnice v pondělí');
  });

  it('přístupnost: každý obrázek má alt, každé pole formuláře popisek', async () => {
    for (const url of [
      '/',
      '/aktuality',
      '/akce',
      '/galerie',
      '/dokumenty',
      '/dotace',
      '/uredni-deska',
      '/hledat?q=obec',
      '/obecni-urad',
    ]) {
      const html = (await verejne().get(url)).text;
      // atribut poskládaný v escapovaném výstupu šablony (chyba z etapy 0: aria-current=&quot;page&quot;)
      expect(html, url).not.toMatch(/\s[a-z-]+=&quot;/);
      for (const img of html.match(/<img\b[^>]*>/g) ?? []) expect(img, `${url}: ${img}`).toMatch(/\salt="/);
      for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const attrs = m[2]!;
        if (/type="(hidden|submit)"/.test(attrs)) continue;
        const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
        expect(id && html.includes(`for="${id}"`), `${url}: pole bez popisku ${m[0]}`).toBe(true);
      }
    }
  });
});
