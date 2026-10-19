// Obecní web — nálezy code review: naplánované aktuality nikde neuniknou, obnova revize skrytého obsahu,
// smyčky přesměrování, adresa konceptu podle titulku, náhled nic nezapisuje, souběžné uložení, upozornění na
// konec dotace jen po odeslaném e-mailu, soubor na disk dřív než řádek v databázi.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/index.js';
import { SouboroveUloziste } from '../src/lib/soubory.js';
import { PRAZDNA_POLE } from '../src/moduly/web/obsah.js';
import { upozorniNaKonecDotaci } from '../src/moduly/web/udrzba.js';
import { datumPraha, pridejDny } from '../src/lib/datum.js';
import { csrfZ, postSoubory, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
let red: Prohlizec;
beforeAll(async () => {
  t = await spustTestApp();
  red = await prihlasSRoli(t, '777700001', ['web']);
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});
const verejne = () => new Prohlizec(t.base);
const obsah = () => t.app.web.obsah;

describe('naplánované aktuality', () => {
  it('budoucí aktualita není v hledání, RSS, sitemap, výpisu kategorie ani na své adrese', async () => {
    const kat = (await obsah().kategorie())[0]!;
    const zitra = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const vcera = new Date(Date.now() - 86_400_000).toISOString();
    const pole = { ...PRAZDNA_POLE, kategorie_id: kat.id, obsah_html: '<p>Kvakoslav oznamuje</p>' };
    await obsah().uloz(
      null,
      'aktualita',
      { ...pole, titulek: 'Budoucí kvakoslav', datum: zitra },
      'zverejnit',
      null,
    );
    await obsah().uloz(
      null,
      'aktualita',
      { ...pole, titulek: 'Minulý kvakoslav', datum: vcera },
      'zverejnit',
      null,
    );

    expect((await obsah().hledej('kvakoslav')).map((o) => o.titulek)).toEqual(['Minulý kvakoslav']);
    const hledat = await verejne().get('/hledat?q=kvakoslav');
    expect(hledat.text).toContain('Minulý kvakoslav');
    expect(hledat.text).not.toContain('Budoucí kvakoslav');
    const rss = await verejne().get('/aktuality/rss.xml');
    expect(rss.text).toContain('Minulý kvakoslav');
    expect(rss.text).not.toContain('Budoucí kvakoslav');
    const mapa = await verejne().get('/sitemap.xml');
    expect(mapa.text).toContain('/aktuality/minuly-kvakoslav');
    expect(mapa.text).not.toContain('budouci-kvakoslav');
    const vypis = await verejne().get(`/aktuality?kategorie=${kat.slug}`);
    expect(vypis.text).toContain('Minulý kvakoslav');
    expect(vypis.text).not.toContain('Budoucí kvakoslav');
    expect((await verejne().get('/aktuality/budouci-kvakoslav')).res.status).toBe(404);
    expect(await obsah().podleSlugu('aktualita', 'budouci-kvakoslav')).toBeUndefined();
  });
});

describe('obnova revize', () => {
  it('skrytý obsah: obnovená verze zahodí starý koncept a nepoužije obsazenou adresu ani smazaného rodiče', async () => {
    const rodic = await obsah().uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Rodič revize' },
      'zverejnit',
      null,
    );
    const id = await obsah().uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Revizní stránka', nadrazena_id: rodic, obsah_html: '<p>verze 1</p>' },
      'zverejnit',
      null,
    );
    const prvni = (await obsah().revize(id)).at(-1)!;
    // stránka se přejmenuje (adresa se uvolní), skryje, rodič smazán; adresu mezitím obsadí jiná stránka
    await obsah().uloz(
      id,
      'stranka',
      {
        ...PRAZDNA_POLE,
        titulek: 'Revizní stránka',
        slug: 'jina-adresa',
        nadrazena_id: rodic,
        obsah_html: '<p>verze 2</p>',
      },
      'zverejnit',
      null,
    );
    await obsah().skryj(id, (await uzivatel()).id);
    await obsah().doKose(rodic, true, (await uzivatel()).id);
    await obsah().uloz(null, 'stranka', { ...PRAZDNA_POLE, titulek: 'Revizní stránka' }, 'zverejnit', null);
    await t.db
      .updateTable('web_obsah')
      .set({ koncept: JSON.stringify({ titulek: 'stará rozpracovaná' }), koncept_at: new Date() })
      .where('id', '=', id)
      .execute();

    expect(await obsah().obnovRevizi(id, prvni.id, (await uzivatel()).id)).toBe(true);
    const o = (await obsah().podleId(id))!;
    expect(o.obsah_html).toBe('<p>verze 1</p>');
    expect(o.koncept).toBeNull();
    expect(o.slug).toBe('revizni-stranka-2');
    expect(o.nadrazena_id).toBeNull();
  });
});

describe('přesměrování', () => {
  it('smyčky a přesměrování samo na sebe se neuloží', async () => {
    const p = t.app.web.presmerovani;
    expect(await p.pridej('/smycka-a', '/smycka-b')).toBe('ulozeno');
    expect(await p.pridej('/smycka-b', '/smycka-a')).toBe('smycka');
    expect(await p.pridej('/smycka-b', '/Smycka-A/')).toBe('smycka');
    expect(await p.pridej('/sam', '/sam/')).toBe('stejna');
    expect(await p.pridej('/sam', '/SAM')).toBe('stejna');
    // řetězec delší než pět skoků se také odmítne
    for (let i = 1; i <= 5; i++) expect(await p.pridej(`/retez-${i}`, `/retez-${i + 1}`)).toBe('ulozeno');
    expect(await p.pridej('/retez-0', '/retez-1')).toBe('smycka');
    // změna cíle existujícího záznamu, která kruh neuzavře, projde; cizí web vždy
    expect(await p.pridej('/smycka-a', '/jinam')).toBe('ulozeno');
    expect(await p.pridej('/smycka-b', '/smycka-a')).toBe('ulozeno');
    expect(await p.pridej('/stary-web', 'https://jiny.example/')).toBe('ulozeno');
    expect(await p.cil('/smycka-b')).toBe('/smycka-a');
  });

  it('správa přesměrování ohlásí smyčku', async () => {
    const spr = await prihlasSRoli(t, '777700002', ['spravce']);
    await t.app.web.presmerovani.pridej('/sprava-x', '/sprava-y');
    const form = await spr.get('/sprava/web/presmerovani');
    const r = await spr.post('/sprava/web/presmerovani', {
      _csrf: csrfZ(form.text),
      stara: '/sprava-y',
      nova: '/sprava-x',
    });
    expect(r.text).toContain('smyčku');
    expect(await t.app.web.presmerovani.cil('/sprava-y')).toBeNull();
  });
});

describe('adresa konceptu', () => {
  it('prázdné automatické uložení nezamkne adresu na „bez-nazvu“; po zveřejnění se adresa už nemění', async () => {
    const id = await obsah().uloz(
      null,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Bez názvu' },
      'autosave',
      null,
    );
    expect((await obsah().podleId(id))?.slug).toBe('bez-nazvu');
    // editor posílá zpátky stávající adresu z pole formuláře
    await obsah().uloz(
      id,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Svoz bioodpadu', slug: 'bez-nazvu' },
      'autosave',
      null,
    );
    expect((await obsah().podleId(id))?.slug).toBe('svoz-bioodpadu');
    await obsah().uloz(
      id,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Svoz bioodpadu', slug: 'svoz-bioodpadu' },
      'zverejnit',
      null,
    );
    await obsah().uloz(
      id,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Svoz bioodpadu v úterý', slug: 'svoz-bioodpadu' },
      'zverejnit',
      null,
    );
    expect((await obsah().podleId(id))?.slug).toBe('svoz-bioodpadu');
  });

  it('ručně zadaná adresa konceptu se při změně titulku nepřepíše', async () => {
    const id = await obsah().uloz(
      null,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Pozvánka', slug: 'moje-adresa' },
      'koncept',
      null,
    );
    await obsah().uloz(
      id,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Pozvánka na ples', slug: 'moje-adresa' },
      'koncept',
      null,
    );
    expect((await obsah().podleId(id))?.slug).toBe('moje-adresa');
  });

  it('stránka nejvyšší úrovně se nesmí jmenovat jako adresa aplikace (i /velikost)', async () => {
    const id = await obsah().uloz(null, 'stranka', { ...PRAZDNA_POLE, titulek: 'Velikost' }, 'koncept', null);
    expect((await obsah().podleId(id))?.slug).toBe('velikost-obec');
  });

  it('souběžné uložení dvou položek se stejným titulkem dostane dvě různé adresy', async () => {
    const ids = await Promise.all(
      [1, 2, 3].map(() =>
        obsah().uloz(null, 'aktualita', { ...PRAZDNA_POLE, titulek: 'Souběžná zpráva' }, 'koncept', null),
      ),
    );
    const slugy = await Promise.all(ids.map(async (id) => (await obsah().podleId(id))!.slug));
    expect(new Set(slugy).size).toBe(3);
  });
});

describe('náhled', () => {
  it('nepřepíše popis uloženého obrázku ani neuloží nově vybraný', async () => {
    const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#123456' } })
      .png()
      .toBuffer();
    const v = await t.app.soubory.uloz({ data: png, nazev: 'a.png', druh: 'obrazek', alt: 'Původní popis' });
    if ('chyba' in v) throw new Error(v.chyba);
    const id = await obsah().uloz(
      null,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'S obrázkem', obrazek_id: v.soubor.id },
      'koncept',
      null,
    );
    const pocet = async () =>
      Number(
        (
          await t.db
            .selectFrom('soubory')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const pred = await pocet();
    const strana = await red.get(`/sprava/web/obsah/${id}`);
    const r = await postSoubory(
      red,
      '/sprava/web/nahled',
      { _csrf: csrfZ(strana.text), id, titulek: 'S obrázkem', obrazek_alt: 'Změněný popis' },
      [{ pole: 'obrazek', nazev: 'b.png', data: png }],
    );
    expect(r.text).toContain('NÁHLED');
    expect(r.text).toContain('Změněný popis');
    expect((await t.app.soubory.podleId(v.soubor.id))?.alt).toBe('Původní popis');
    expect(await pocet()).toBe(pred);
  });
});

describe('dotace a adresy', () => {
  it('konec dotace: „upozorněno“ jen když aspoň jeden e-mail odešel', async () => {
    await t.db
      .updateTable('uzivatele')
      .set({ email: 'spravce-dotace@testov.cz' })
      .where('telefon', '=', '+420777700002')
      .execute();
    const d = t.app.web.dotace;
    const id = await d.uloz(null, { projekt: 'Lávka', poskytovatel: 'Kraj', text: '', odkaz: '' }, null);
    const dnes = datumPraha(new Date());
    await d.zobrazeni(id, { od: dnes, do: pridejDny(dnes, 10), vPaticce: false, poradi: 1 }, null);
    const puvodni = t.app.mail.posli.bind(t.app.mail);
    t.app.mail.posli = async () => {
      throw new Error('SMTP nedostupné');
    };
    try {
      expect(await upozorniNaKonecDotaci(t.app)).toBe(0);
    } finally {
      t.app.mail.posli = puvodni;
    }
    expect((await d.podleId(id))?.upozorneno_at).toBeNull();
    expect(await upozorniNaKonecDotaci(t.app)).toBe(1);
    expect((await d.podleId(id))?.upozorneno_at).not.toBeNull();
  });

  it('adresy podstránek pro hledání jedním dotazem', async () => {
    const rodic = await obsah().uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Spolky' },
      'zverejnit',
      null,
    );
    const dite = await obsah().uloz(
      null,
      'stranka',
      { ...PRAZDNA_POLE, titulek: 'Hasiči', nadrazena_id: rodic },
      'zverejnit',
      null,
    );
    const radky = await Promise.all([rodic, dite].map(async (x) => (await obsah().podleId(x))!));
    expect(await obsah().urlMnoha(radky)).toEqual(['/spolky', '/spolky/hasici']);
  });
});

describe('úložiště souborů', () => {
  it('nejdřív soubor, pak řádek: chyba zápisu nenechá řádek, chyba řádku nenechá soubor', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const pocet = async () =>
      Number(
        (
          await t.db
            .selectFrom('soubory')
            .select((eb) => eb.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    // 1) disk nejde zapsat (místo adresáře „soubory“ leží soubor) → žádný řádek
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mo-soubory-'));
    await fs.writeFile(path.join(dir, 'soubory'), 'blokuje');
    const pred = await pocet();
    await expect(
      new SouboroveUloziste(t.db, dir).uloz({ data: png, nazev: 'x.png', druh: 'obrazek' }),
    ).rejects.toThrow();
    await expect(
      new SouboroveUloziste(t.db, dir).uloz({
        data: Buffer.from('WEBVTT\n\n'),
        nazev: 'x.vtt',
        druh: 'titulky',
      }),
    ).rejects.toThrow();
    expect(await pocet()).toBe(pred);
    // 2) databáze řádek odmítne → zapsané soubory se smažou
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'mo-soubory-'));
    const vadnaDb = new Proxy(t.db, {
      get(cil, klic, prijemce) {
        if (klic === 'insertInto')
          return () => {
            throw new Error('databáze nedostupná');
          };
        return Reflect.get(cil, klic, prijemce) as unknown;
      },
    }) as Db;
    await expect(
      new SouboroveUloziste(vadnaDb, dir2).uloz({ data: png, nazev: 'y.png', druh: 'obrazek' }),
    ).rejects.toThrow(/nedostupná/);
    const zbylo = await fs.readdir(path.join(dir2, 'soubory'), { recursive: true, withFileTypes: true });
    expect(zbylo.filter((f) => f.isFile())).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dir2, { recursive: true, force: true });
  });
});

async function uzivatel() {
  return t.db
    .selectFrom('uzivatele')
    .select('id')
    .where('telefon', '=', '+420777700001')
    .executeTakeFirstOrThrow();
}
