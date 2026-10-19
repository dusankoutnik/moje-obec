// Videa webu: správa (YouTube s lokálním náhledem, vlastní MP4, titulky, pořadí, koš), titulka a /videa bez
// načítání cizích serverů (žádný iframe ani obrázek z YouTube v HTML), video v textu stránky, HTTP Range u souborů,
// limit nahrávání a převod videí při importu starého webu (WordPress).
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { naWebVtt } from '../src/lib/soubory.js';
import { najdiVidea } from '../src/moduly/web/import/html-pomoc.js';
import { Importer } from '../src/moduly/web/import/importer.js';
import type { ImportniZdroj, Stahovac } from '../src/moduly/web/import/typy.js';
import { idVideiVTextu, parsujOdkazVidea } from '../src/moduly/web/videa.js';
import { limitNahrani } from '../src/web/nahravani.js';
import { rozsah } from '../src/web/soubory.js';
import {
  csrfZ,
  MALE_PDF,
  postSoubory,
  prihlasSRoli,
  Prohlizec,
  spustTestApp,
  type TestApp,
} from './pomocnici.js';

let t: TestApp;
let red: Prohlizec;
let jpeg: Buffer;
const stazeno: string[] = [];

// nejmenší MP4, které file-type pozná (ftyp box + kousek dat)
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('mp42isom', 'latin1'),
  Buffer.from([0, 0, 0, 8]),
  Buffer.from('free', 'latin1'),
  Buffer.alloc(200, 7),
]);

beforeAll(async () => {
  t = await spustTestApp();
  red = await prihlasSRoli(t, '777600001', ['web']);
  jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#3a6' } })
    .jpeg()
    .toBuffer();
  // náhledy a názvy z YouTube/Vimea se nestahují ze sítě
  t.app.web.videa.fetch = async (url: string) => {
    stazeno.push(url);
    if (url.includes('/oembed'))
      return new Response(JSON.stringify({ title: 'Letecké snímkování obce 2022' }), {
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('maxresdefault'))
      return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    return new Response('', { status: 404 });
  };
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const verejne = () => new Prohlizec(t.base);
async function formular() {
  return csrfZ((await red.get('/sprava/web/videa')).text);
}
async function video(nazev: string) {
  return t.db.selectFrom('web_videa').selectAll().where('nazev', '=', nazev).executeTakeFirstOrThrow();
}

describe('pomůcky videí', () => {
  it('odkazy na YouTube a Vimeo', () => {
    const yt = { zdroj: 'youtube', id: 'p2XGixzTB8E' };
    expect(parsujOdkazVidea('https://www.youtube.com/watch?v=p2XGixzTB8E&t=10s')).toEqual(yt);
    expect(parsujOdkazVidea('https://youtu.be/p2XGixzTB8E')).toEqual(yt);
    expect(parsujOdkazVidea('https://www.youtube.com/embed/p2XGixzTB8E?feature=oembed')).toEqual(yt);
    expect(parsujOdkazVidea('https://www.youtube-nocookie.com/embed/p2XGixzTB8E')).toEqual(yt);
    expect(parsujOdkazVidea('https://m.youtube.com/shorts/p2XGixzTB8E')).toEqual(yt);
    expect(parsujOdkazVidea('https://vimeo.com/76979871')).toEqual({ zdroj: 'vimeo', id: '76979871' });
    expect(parsujOdkazVidea('https://vimeo.com/76979871/abc123def0')).toEqual({
      zdroj: 'vimeo',
      id: '76979871:abc123def0',
    });
    expect(parsujOdkazVidea('https://player.vimeo.com/video/76979871?h=ff00aa')).toEqual({
      zdroj: 'vimeo',
      id: '76979871:ff00aa',
    });
    expect(parsujOdkazVidea('https://www.youtube.com/watch?v=kratke')).toBeNull();
    expect(parsujOdkazVidea('javascript:alert(1)')).toBeNull();
    expect(parsujOdkazVidea('https://example.com/video.mp4')).toBeNull();
  });

  it('titulky: WebVTT projde, SRT se převede, jiný text ne', () => {
    expect(naWebVtt('﻿WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nAhoj')).toBe(
      'WEBVTT\n\n00:00.000 --> 00:01.000\nAhoj',
    );
    expect(naWebVtt('1\n00:00:01,000 --> 00:00:02,500\nDobrý den\n')).toBe(
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nDobrý den\n',
    );
    expect(naWebVtt('<html>ne</html>')).toBeNull();
  });

  it('HTTP Range: rozsahy, posledních n bajtů, mimo soubor, víc rozsahů ignorovat', () => {
    expect(rozsah('bytes=0-9', 100)).toEqual({ start: 0, konec: 9 });
    expect(rozsah('bytes=90-', 100)).toEqual({ start: 90, konec: 99 });
    expect(rozsah('bytes=-10', 100)).toEqual({ start: 90, konec: 99 });
    expect(rozsah('bytes=50-500', 100)).toEqual({ start: 50, konec: 99 });
    expect(rozsah('bytes=100-', 100)).toBe('mimo');
    expect(rozsah('bytes=500-600', 100)).toBe('mimo');
    expect(rozsah('bytes=0-1,5-6', 100)).toBeNull();
    expect(rozsah('items=0-1', 100)).toBeNull();
  });

  it('limit nahrávání: 300 MB jen přihlášenému ve správě videí', () => {
    const req = (url: string, uzivatelId?: string) => ({ url, session: { uzivatelId } }) as never;
    expect(limitNahrani(req('/sprava/web/videa', 'u'))).toBe(300 * 1024 * 1024);
    expect(limitNahrani(req('/sprava/web/videa/abc', 'u'))).toBe(300 * 1024 * 1024);
    expect(limitNahrani(req('/sprava/web/videa'))).toBe(30 * 1024 * 1024);
    expect(limitNahrani(req('/sprava/web/galerie', 'u'))).toBe(30 * 1024 * 1024);
    expect(limitNahrani(req('/sprava/web/videax', 'u'))).toBe(30 * 1024 * 1024);
  });

  it('import: najde iframe YouTube, <video> z WordPressu, [video], [embed] a blok Vložení', () => {
    const html = [
      '<p><iframe loading="lazy" title="YouTube video player" src="https://www.youtube.com/embed/p2XGixzTB8E" width="710" height="400" allowfullscreen="allowfullscreen"></iframe></p>',
      '<div style="width: 709px;" class="wp-video"><video class="wp-video-shortcode" id="video-9201-2" poster="https://obec.cz/wp-content/uploads/2024/06/screenshot-5.jpg" preload="metadata" controls="controls"><source type="video/mp4" src="https://obec.cz/wp-content/uploads/2024/06/obec2024.mp4?_=2" /><a href="https://obec.cz/wp-content/uploads/2024/06/obec2024.mp4">https://obec.cz/wp-content/uploads/2024/06/obec2024.mp4</a></video></div>',
      '[video mp4="/wp-content/uploads/pout.mp4" poster="/wp-content/uploads/pout.jpg"][/video]',
      '[embed]https://vimeo.com/76979871[/embed]',
      '<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">\nhttps://youtu.be/AAAAAAAAAAA\n</div><figcaption>Masopust 2023</figcaption></figure>',
      '<iframe src="https://www.google.com/maps/embed?pb=x"></iframe>',
    ].join('\n');
    const r = najdiVidea(html, 'https://obec.cz');
    expect(r.videa).toEqual([
      { zdroj: 'youtube', id: 'AAAAAAAAAAA', nazev: 'Masopust 2023' },
      { zdroj: 'youtube', id: 'p2XGixzTB8E', nazev: undefined },
      {
        zdroj: 'soubor',
        url: 'https://obec.cz/wp-content/uploads/2024/06/obec2024.mp4',
        plakatUrl: 'https://obec.cz/wp-content/uploads/2024/06/screenshot-5.jpg',
      },
      {
        zdroj: 'soubor',
        url: 'https://obec.cz/wp-content/uploads/pout.mp4',
        plakatUrl: 'https://obec.cz/wp-content/uploads/pout.jpg',
      },
      { zdroj: 'vimeo', id: '76979871', nazev: undefined },
    ]);
    expect(r.html).not.toMatch(/<video|youtube\.com\/embed|\[video|\[embed/);
    expect(r.html).toContain('google.com/maps'); // cizí iframe nechává importéru (ten ho zahodí)
  });
});

describe('správa videí', () => {
  it('bez role web nejde', async () => {
    const obcan = await prihlasSRoli(t, '777600009', []);
    expect((await obcan.get('/sprava/web/videa')).res.status).toBe(403);
  });

  it('YouTube: náhled se stáhne k nám, na titulce jen obrázek a tlačítko — žádný iframe', async () => {
    const r = await postSoubory(
      red,
      '/sprava/web/videa',
      {
        _csrf: await formular(),
        zdroj: 'odkaz',
        odkaz: 'https://www.youtube.com/watch?v=p2XGixzTB8E',
        nazev: '',
        popis: 'Obec z ptačí perspektivy',
        na_titulce: 'ano',
        akce: 'zverejnit',
      },
      [],
    );
    expect(r.text).toContain('Hotovo, video je na webu.');
    const v = await video('Letecké snímkování obce 2022'); // název z oEmbed
    expect(v.zdroj).toBe('youtube');
    expect(v.externi_id).toBe('p2XGixzTB8E');
    expect(v.plakat_id).toBeTruthy();
    expect(stazeno.some((u) => u.includes('i.ytimg.com/vi/p2XGixzTB8E/maxresdefault.jpg'))).toBe(true);
    const plakat = await t.app.soubory.podleId(v.plakat_id!);
    expect(plakat?.zdroj_url).toContain('i.ytimg.com');

    const uvod = await verejne().get('/');
    expect(uvod.text).toContain('id="h-videa"');
    expect(uvod.text).toContain('Letecké snímkování obce 2022');
    expect(uvod.text).toContain(`/soubory/${v.plakat_id}/`);
    expect(uvod.text).not.toMatch(/<iframe/i);
    expect(uvod.text).not.toContain('i.ytimg.com');
    expect(uvod.text).not.toContain('www.youtube.com/embed');
    // přehrávač až po kliknutí (nocookie), bez JS odkaz na YouTube, přístupný název tlačítka
    expect(uvod.text).toContain(
      'data-prehravac="https://www.youtube-nocookie.com/embed/p2XGixzTB8E?autoplay=1',
    );
    expect(uvod.text).toContain('href="https://www.youtube.com/watch?v=p2XGixzTB8E"');
    expect(uvod.text).toMatch(/Přehrát video<span class="vh"> „Letecké snímkování obce 2022“<\/span>/);
    expect(uvod.text).toContain('Načte se z YouTube (Google)');
  });

  it('vlastní MP4 s plakátem a titulky; koncept není vidět; Range 206/416', async () => {
    const vtt = Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\nVítejte ve Vlastibořicích\n');
    const r = await postSoubory(
      red,
      '/sprava/web/videa',
      {
        _csrf: await formular(),
        zdroj: 'soubor',
        nazev: 'Vlastibořice 2024',
        popis: 'Obec v roce 2024',
        prepis: 'Záběry obce z dronu.\n\nHudba bez slov.',
        akce: 'koncept',
      },
      [
        { pole: 'soubor', nazev: 'obec.mp4', data: MP4, typ: 'video/mp4' },
        { pole: 'plakat', nazev: 'plakat.jpg', data: jpeg, typ: 'image/jpeg' },
        { pole: 'titulky', nazev: 'cz.vtt', data: vtt, typ: 'text/vtt' },
      ],
    );
    expect(r.text).toContain('Video „Vlastibořice 2024“ je uložené.');
    const v = await video('Vlastibořice 2024');
    expect(v.stav).toBe('koncept');
    expect(v.soubor_id && v.plakat_id && v.titulky_id).toBeTruthy();
    expect((await verejne().get('/videa')).text).not.toContain('Vlastibořice 2024');

    // zveřejnit + na titulku
    const detail = await red.get(`/sprava/web/videa/${v.id}`);
    await postSoubory(
      red,
      `/sprava/web/videa/${v.id}`,
      { _csrf: csrfZ(detail.text), nazev: 'Vlastibořice 2024', na_titulce: 'ano', akce: 'zverejnit' },
      [],
    );
    const stranka = await verejne().get('/videa');
    expect(stranka.text).toContain('<video controls preload="none" playsinline');
    expect(stranka.text).toContain(`poster="/soubory/${v.plakat_id}/`);
    expect(stranka.text).toMatch(/<source src="\/soubory\/[0-9a-f-]+\/obec\.mp4" type="video\/mp4">/);
    expect(stranka.text).toContain('<track kind="captions"');
    expect(stranka.text).toContain('Textový popis videa');
    expect(stranka.text).toContain('<p>Hudba bez slov.</p>');

    const url = `${t.base}/soubory/${v.soubor_id}/obec.mp4`;
    const cely = await fetch(url);
    expect(cely.status).toBe(200);
    expect(cely.headers.get('accept-ranges')).toBe('bytes');
    expect(cely.headers.get('content-type')).toBe('video/mp4');
    expect(cely.headers.get('content-disposition')).toMatch(/^inline/);
    expect(Buffer.from(await cely.arrayBuffer()).equals(MP4)).toBe(true);
    const cast = await fetch(url, { headers: { range: 'bytes=4-11' } });
    expect(cast.status).toBe(206);
    expect(cast.headers.get('content-range')).toBe(`bytes 4-11/${MP4.length}`);
    expect(cast.headers.get('content-length')).toBe('8');
    expect(Buffer.from(await cast.arrayBuffer()).toString('latin1')).toBe('ftypmp42');
    const mimo = await fetch(url, { headers: { range: `bytes=${MP4.length + 5}-` } });
    expect(mimo.status).toBe(416);
    expect(mimo.headers.get('content-range')).toBe(`bytes */${MP4.length}`);
    const tit = await fetch(`${t.base}/soubory/${v.titulky_id}/cz.vtt`);
    expect(tit.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
  });

  it('jiný soubor než video odmítne a formulář vrátí s chybou', async () => {
    const r = await postSoubory(
      red,
      '/sprava/web/videa',
      { _csrf: await formular(), zdroj: 'soubor', nazev: 'Omyl', akce: 'zverejnit' },
      [{ pole: 'soubor', nazev: 'zapis.pdf', data: MALE_PDF, typ: 'application/pdf' }],
    );
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('Tento soubor není video MP4 ani WebM');
    expect(r.text).toContain('value="Omyl"');
    const spatny = await postSoubory(
      red,
      '/sprava/web/videa',
      { _csrf: await formular(), zdroj: 'odkaz', odkaz: 'https://example.com/x', akce: 'zverejnit' },
      [],
    );
    expect(spatny.res.status).toBe(400);
    expect(spatny.text).toContain('Tento odkaz neznáme');
  });

  it('pořadí šipkami, koš a obnovení', async () => {
    const a = await video('Letecké snímkování obce 2022');
    const b = await video('Vlastibořice 2024');
    let seznam = await t.app.web.videa.seznam({ verejne: true });
    expect(seznam.map((x) => x.id)).toEqual([a.id, b.id]);
    const list = await red.get('/sprava/web/videa');
    await red.post(`/sprava/web/videa/${b.id}`, { _csrf: csrfZ(list.text), akce: 'nahoru' });
    seznam = await t.app.web.videa.seznam({ verejne: true });
    expect(seznam.map((x) => x.id)).toEqual([b.id, a.id]);
    const uvod = await verejne().get('/');
    expect(uvod.text.indexOf('Vlastibořice 2024')).toBeLessThan(uvod.text.indexOf('Letecké snímkování'));

    await red.post(`/sprava/web/videa/${b.id}`, { _csrf: csrfZ(list.text), akce: 'kos' });
    expect((await verejne().get('/')).text).not.toContain('Vlastibořice 2024');
    const kos = await red.get('/sprava/web/kos');
    expect(kos.text).toContain('Vlastibořice 2024');
    await red.post(`/sprava/web/videa/${b.id}`, { _csrf: csrfZ(kos.text), akce: 'obnovit' });
    expect((await verejne().get('/videa')).text).toContain('Vlastibořice 2024');
  });

  it('video vložené do textu stránky se vykreslí jako přehrávač (a koncept videa ne)', async () => {
    const v = await video('Letecké snímkování obce 2022');
    const form = await red.get('/sprava/web/novy?typ=stranka');
    await postSoubory(
      red,
      '/sprava/web/novy',
      {
        _csrf: csrfZ(form.text),
        typ: 'stranka',
        titulek: 'Obec z výšky',
        obsah_html: `<p>Úvod</p><figure class="video" data-video="${v.id}" onclick="x()"><a href="https://www.youtube.com/watch?v=p2XGixzTB8E">Letecké</a></figure><p>Konec</p>`,
        v_menu: 'ano',
        akce: 'zverejnit',
      },
      [],
    );
    const o = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Obec z výšky')
      .executeTakeFirstOrThrow();
    expect(o.obsah_html).not.toContain('onclick');
    expect(idVideiVTextu(o.obsah_html)).toEqual([v.id]);
    const s = await verejne().get('/obec-z-vysky');
    expect(s.text).toContain('class="video-v-obsahu"');
    expect(s.text).toContain('data-prehravac="https://www.youtube-nocookie.com/embed/p2XGixzTB8E');
    expect(s.text).not.toMatch(/<iframe/i);
    expect(s.text.indexOf('Úvod')).toBeLessThan(s.text.indexOf('video-v-obsahu'));
    // video stažené do konceptu na stránce zmizí (odkaz zálohy se nevypíše)
    await t.app.web.videa.nastavStav(v.id, 'koncept', null);
    const bez = await verejne().get('/obec-z-vysky');
    expect(bez.text).not.toContain('video-v-obsahu');
    expect(bez.text).toContain('Konec');
    await t.app.web.videa.nastavStav(v.id, 'zverejneno', null);
  });
});

describe('import videí ze starého webu', () => {
  it('WordPress: iframe YouTube a <video> z obsahu → videa v knihovně, značky v textu, bez duplicit', async () => {
    const Z = 'https://stara-obec.cz';
    const stahovac: Stahovac = {
      stazeno: 0,
      async text() {
        return '';
      },
      async json() {
        throw new Error('ne');
      },
      async soubor(url) {
        stazeno.push(url);
        if (url.endsWith('.mp4')) return { data: MP4, typ: 'video/mp4' };
        if (url.endsWith('.jpg')) return { data: jpeg, typ: 'image/jpeg' };
        return null;
      },
    };
    const html =
      '<p><iframe loading="lazy" title="YouTube video player" src="https://www.youtube.com/embed/p2XGixzTB8E" width="710" height="400"></iframe></p><h2>Vlastibořice</h2>' +
      `<div class="wp-video"><video class="wp-video-shortcode" poster="${Z}/wp-content/uploads/2024/06/screenshot-5.jpg" preload="metadata" controls="controls"><source type="video/mp4" src="${Z}/wp-content/uploads/2024/06/obec2024.mp4?_=2" /><a href="${Z}/wp-content/uploads/2024/06/obec2024.mp4">${Z}/wp-content/uploads/2024/06/obec2024.mp4</a></video></div>` +
      '<p><iframe src="https://cizi.example/mapa"></iframe></p>';
    const zdroj: ImportniZdroj = {
      nazev: 'test',
      zaklad: Z,
      async *stranky() {
        yield { klic: '1', url: `${Z}/obec/letecke-snimkovani/`, titulek: 'Letecké snímkování', html };
      },
      async *aktuality() {},
    };
    const imp = new Importer(
      zdroj,
      {
        db: t.db,
        obsah: t.app.web.obsah,
        soubory: t.app.soubory,
        presmerovani: t.app.web.presmerovani,
        dotace: t.app.web.dotace,
      },
      stahovac,
      { aktualityOd: new Date('2020-01-01'), menu: false, dotace: false, deska: false },
    );
    const vysledek = await imp.spust();
    expect(vysledek.chyby).toEqual([]);
    expect(vysledek.videa).toBe(1); // YouTube už v knihovně je (z testu správy) → jen vlastní MP4 nové
    const o = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('puvodni_url', '=', `${Z}/obec/letecke-snimkovani/`)
      .executeTakeFirstOrThrow();
    const ids = idVideiVTextu(o.obsah_html);
    expect(ids).toHaveLength(2);
    expect(o.obsah_html).not.toMatch(/iframe|<video|mo-video/);
    const mp4 = await t.app.web.videa.podleId(ids[1]!);
    expect(mp4?.zdroj).toBe('soubor');
    expect(mp4?.plakat_id).toBeTruthy();
    expect(mp4?.na_titulce).toBe(false);
    expect(mp4?.stav).toBe('zverejneno');
    const s = await verejne().get('/letecke-snimkovani');
    expect(s.text).toContain('<video controls preload="none"');
    expect(s.text).toContain('data-prehravac="https://www.youtube-nocookie.com/embed/p2XGixzTB8E');
  });
});
