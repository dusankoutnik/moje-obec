// Text obce k nativním stránkám (kontakt, GDPR, přístupnost), mapa stránek generovaná ze stromu
// a rozcestník, který neopakuje odkazy uvedené v textu stránky.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obecZObjektu } from '../src/config/obec.js';
import { stromMapy } from '../src/moduly/web/mapa.js';
import { Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());

const verejne = () => new Prohlizec(t.base);

async function stranka(v: {
  titulek: string;
  slug: string;
  html?: string;
  typ?: 'stranka' | 'odkaz';
  odkaz?: string;
  rodic?: string | null;
  vMenu?: boolean;
  stav?: 'zverejneno' | 'koncept';
  poradi?: number;
}) {
  const r = await t.db
    .insertInto('web_obsah')
    .values({
      typ: v.typ ?? 'stranka',
      titulek: v.titulek,
      slug: v.slug,
      obsah_html: v.html ?? '',
      odkaz_url: v.odkaz ?? '',
      nadrazena_id: v.rodic ?? null,
      v_menu: v.vMenu ?? false,
      stav: v.stav ?? 'zverejneno',
      poradi: v.poradi ?? 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  t.app.web.obsah.zmena();
  return r.id;
}

describe('text obce k nativním stránkám', () => {
  it('kontakt zobrazí zveřejněný doplněk, samostatná adresa doplňku přesměruje', async () => {
    const p = verejne();
    expect((await p.get('/kontakt')).text).not.toContain('Profil zadavatele XY');
    await stranka({ titulek: 'Kontakt', slug: 'kontakt-obec', html: '<p>Profil zadavatele XY</p>' });
    const k = await p.get('/kontakt');
    expect(k.text).toContain('Profil zadavatele XY');
    expect(k.text).toContain('obec@testov.cz'); // údaje z profilu obce zůstávají
    const r = await p.get('/kontakt-obec', false);
    expect(r.res.status).toBe(301);
    expect(r.res.headers.get('location')).toBe('/kontakt');
  });

  it('koncept doplňku se nezobrazí', async () => {
    await stranka({
      titulek: 'Ochrana',
      slug: 'ochrana-osobnich-udaju-obec',
      html: '<p>Memorandum obce</p>',
      stav: 'koncept',
    });
    expect((await verejne().get('/ochrana-osobnich-udaju')).text).not.toContain('Memorandum obce');
    await t.db
      .updateTable('web_obsah')
      .set({ stav: 'zverejneno' })
      .where('slug', '=', 'ochrana-osobnich-udaju-obec')
      .execute();
    const g = await verejne().get('/ochrana-osobnich-udaju');
    expect(g.text).toContain('Memorandum obce');
    expect(g.text).toContain('Vaše práva'); // obecná část zůstává, doplněk je navíc
  });

  it('vlastní prohlášení o přístupnosti nahradí obecnou šablonu', async () => {
    expect((await verejne().get('/prohlaseni-o-pristupnosti')).text).toContain('Nepřístupný obsah');
    await stranka({
      titulek: 'Prohlášení',
      slug: 'prohlaseni-o-pristupnosti-obec',
      html: '<p>Stránky jsou částečně v souladu.</p>',
    });
    const s = await verejne().get('/prohlaseni-o-pristupnosti');
    expect(s.text).toContain('Stránky jsou částečně v souladu.');
    expect(s.text).not.toContain('Nepřístupný obsah'); // obecná šablona se nezobrazí
  });

  it('profil obce: poznámka u lidí a telefon pověřence jsou nepovinné', () => {
    const o = obecZObjektu({
      obec: {
        nazev: 'Obec X',
        kratky_nazev: 'X',
        casti: ['X'],
        lide: [{ funkce: 'Knihovnice', jmeno: 'Jana' }],
        poverenec: { jmeno: 'P' },
      },
    });
    expect(o.obec.lide[0]!.poznamka).toBe('');
    expect(o.obec.poverenec.telefon).toBe('');
    expect(o.patika.zasady_cookies).toBe('');
  });
});

describe('mapa stránek a rozcestník', () => {
  it('strom: menu v pořadí, mimo menu jen stránky (bez doplňků a odkazů)', () => {
    const r = (id: string, o: Partial<Parameters<typeof stromMapy>[0][number]>) => ({
      id,
      typ: 'stranka',
      titulek: id,
      slug: id,
      nadrazena_id: null,
      odkaz_url: '',
      v_menu: false,
      ...o,
    });
    const m = stromMapy([
      r('obec', { v_menu: true }),
      r('historie', { nadrazena_id: 'obec' }),
      r('deska', { typ: 'odkaz', odkaz_url: '/uredni-deska', v_menu: true, nadrazena_id: 'obec' }),
      r('stary-odkaz', { typ: 'odkaz', odkaz_url: '/aktuality' }),
      r('kontakt-obec', {}),
      r('terezka', {}),
    ]);
    expect(m.menu).toEqual([
      {
        titulek: 'obec',
        url: '/obec',
        deti: [
          { titulek: 'historie', url: '/obec/historie', deti: [] },
          { titulek: 'deska', url: '/uredni-deska', deti: [] },
        ],
      },
    ]);
    expect(m.mimoMenu.map((x) => x.url)).toEqual(['/terezka']);
  });

  it('/mapa-stranek ukáže menu, moduly a další stránky; koncepty ne', async () => {
    const rodic = await stranka({ titulek: 'Obecní úřad', slug: 'urad', vMenu: true, poradi: 10 });
    await stranka({ titulek: 'CZECHPOINT', slug: 'czechpoint', rodic, vMenu: true });
    await stranka({ titulek: 'Tajný koncept', slug: 'tajny', stav: 'koncept' });
    await stranka({ titulek: 'Běh pro Terezku', slug: 'terezka' });
    const m = await verejne().get('/mapa-stranek');
    expect(m.res.status).toBe(200);
    expect(m.text).toContain('href="/urad/czechpoint"');
    expect(m.text).toContain('href="/terezka"');
    expect(m.text).toContain('href="/uredni-deska"');
    expect(m.text).toContain('href="/povinne-informace"');
    expect(m.text).not.toContain('Tajný koncept');
    expect(m.text).not.toContain('href="/kontakt-obec"');
    // odkaz v patičce
    expect((await verejne().get('/')).text).toContain('href="/mapa-stranek"');
  });

  it('rozcestník neopakuje v dlaždicích odkaz, na který vede text stránky', async () => {
    const rodic = await stranka({
      titulek: 'Služby obce',
      slug: 'sluzby-obce',
      html: '<h2><a href="/ucet">Můj účet</a></h2><p>Popis služby.</p>',
      vMenu: true,
    });
    await stranka({
      titulek: 'Můj účet',
      slug: 'muj-ucet',
      typ: 'odkaz',
      odkaz: '/ucet',
      rodic,
      vMenu: true,
    });
    await stranka({
      titulek: 'Knihovna',
      slug: 'knihovna',
      typ: 'odkaz',
      odkaz: '/knihovna',
      rodic,
      vMenu: true,
    });
    const s = await verejne().get('/sluzby-obce');
    const dlazdice = s.text.slice(s.text.indexOf('dlazdice-podstranek'));
    expect(dlazdice).toContain('href="/knihovna"');
    expect(dlazdice).not.toContain('href="/ucet"');
  });
});
