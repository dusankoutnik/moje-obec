import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agregator,
  jeRobot,
  normalizujCestu,
  prectiSoubor,
  sekceCesty,
  souboryLogu,
  vzoryNaRegex,
} from '../src/moduly/navstevnost/logy.js';
import { grafNavstevniku } from '../src/moduly/navstevnost/graf.js';
import { posunDen } from '../src/moduly/navstevnost/sluzba.js';
import { Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

// fixtury = vymyšlené řádky ve formátu Nginx Proxy Manageru (dokumentační IP adresy z RFC 5737)
const FIX = new URL('./fixtures/navstevnost/', import.meta.url).pathname;
const DEN_A = readFileSync(path.join(FIX, 'den-a.txt'), 'utf8');
const DEN_B = readFileSync(path.join(FIX, 'den-b.txt'), 'utf8');
const DESKA_ID = '11111111-2222-4333-8444-555555555555';

/** adresář s logy jako po rotaci: starší den zabalený (.1.gz), novější v aktuálním logu, k tomu cizí soubory */
function adresarLogu(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'navstevnost-'));
  writeFileSync(path.join(d, 'proxy-host-1_access.log.1.gz'), gzipSync(DEN_A));
  writeFileSync(path.join(d, 'proxy-host-1_access.log'), DEN_B);
  // jiný proxy host a error log se číst nesmějí
  writeFileSync(path.join(d, 'proxy-host-2_access.log'), DEN_B.repeat(5));
  writeFileSync(path.join(d, 'proxy-host-1_error.log'), 'chyba\n');
  return d;
}

describe('normalizace cest a sekce', () => {
  it('odstraní dotaz, koncové lomítko, identifikátory a tokeny', () => {
    expect(normalizujCestu('/aktuality/Test-Clanek/?utm_source=x')).toBe('/aktuality/test-clanek');
    expect(normalizujCestu('/')).toBe('/');
    expect(normalizujCestu('/eknihy/kniha/1797')).toBe('/eknihy/kniha/:id');
    expect(normalizujCestu('/rezervace/platba/0123456789abcdef0123')).toBe('/rezervace/platba/:token');
    expect(normalizujCestu('/ucet/x/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe('/ucet/x/:id');
    expect(normalizujCestu('/potvrzeni/Ab12Cd34Ef56Gh78Ij90Kl12Mn')).toBe('/potvrzeni/:token');
    expect(normalizujCestu('/obec/zpravodaj-2025')).toBe('/obec/zpravodaj-2025');
  });
  it('dokument úřední desky a archiv starého WordPressu zůstanou rozpoznatelné', () => {
    expect(normalizujCestu(`/uredni-deska/${DESKA_ID}`)).toBe(`/uredni-deska/${DESKA_ID}`);
    expect(normalizujCestu('/2024/05/stary-clanek/')).toBe('/2024/05/stary-clanek');
    expect(normalizujCestu('/%C3%BArad')).toBe('/úrad');
  });
  it('sekce podle cesty', () => {
    expect(sekceCesty('/')).toBe('web');
    expect(sekceCesty('/rezervace/kalendar/sal')).toBe('rezervace');
    expect(sekceCesty('/rezervace/spolujizda/nabizim')).toBe('spolujizda');
    expect(sekceCesty('/rezervacex')).toBe('web');
    expect(sekceCesty('/eknihy')).toBe('eknihy');
    expect(sekceCesty('/infokanal/vystrahy')).toBe('infokanal');
    expect(sekceCesty('/ucet/platby')).toBe('ucet');
  });
  it('vzory souborů a chronologické pořadí', async () => {
    const re = vzoryNaRegex('proxy-host-1_access.log*, jiny.log');
    expect(re.test('proxy-host-1_access.log')).toBe(true);
    expect(re.test('proxy-host-1_access.log.3.gz')).toBe(true);
    expect(re.test('proxy-host-11_access.log')).toBe(false);
    expect(re.test('jiny.log')).toBe(true);
    expect(vzoryNaRegex('').test('cokoliv')).toBe(false);
    const d = adresarLogu();
    try {
      const s = (await souboryLogu(d, 'proxy-host-1_access.log*')).map((f) => path.basename(f));
      expect(s).toEqual(['proxy-host-1_access.log.1.gz', 'proxy-host-1_access.log']);
      expect(await souboryLogu(path.join(d, 'neni'), '*')).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('agregace logů', () => {
  it('roboti: UA, vlastní a vnitřní IP, bez načtených stylů, víc než 200 stránek', () => {
    expect(jeRobot({ robotUa: false, stranek: 3, assetu: 2 })).toBe(false);
    expect(jeRobot({ robotUa: false, stranek: 3, assetu: 0 })).toBe(true);
    expect(jeRobot({ robotUa: false, stranek: 201, assetu: 50 })).toBe(true);
    expect(jeRobot({ robotUa: true, stranek: 0, assetu: 0 })).toBe(true);
    expect(jeRobot({ robotUa: false, stranek: 0, assetu: 5 })).toBe(false);
  });

  it('spočítá návštěvníky, zobrazení, stažení a roboty po dnech (pražský čas) a sekcích', async () => {
    const d = adresarLogu();
    try {
      const ag = new Agregator(['192.0.2.1']);
      for (const f of await souboryLogu(d, 'proxy-host-1_access.log*')) await prectiSoubor(f, ag);
      expect(ag.rozpoznanych).toBe(ag.radku - 1); // jeden nesmyslný řádek
      expect(ag.dnyVLogu).toEqual(['2026-10-20', '2026-10-21']);
      const v = ag.vysledek();
      const r = (den: string, sekce: string) => v.find((x) => x.den === den && x.sekce === sekce);
      // 19. 10. 22:30 UTC = 20. 10. 0:30 v Praze
      expect(r('2026-10-19', 'web')).toBeUndefined();
      const web = r('2026-10-20', 'web')!;
      expect(web).toMatchObject({ zobrazeni: 6, navstevnici: 2, stazeni: 1, boti: 5 });
      expect(web.stranky[0]).toEqual({ cesta: '/aktuality/test-clanek', zobrazeni: 3, navstevnici: 2 });
      const cesty = web.stranky.map((s) => s.cesta).sort();
      expect(cesty).toEqual([
        '/',
        '/2024/05/stary-clanek',
        '/aktuality/test-clanek',
        `/uredni-deska/${DESKA_ID}`,
      ]);
      expect(r('2026-10-20', 'rezervace')).toMatchObject({ zobrazeni: 2, navstevnici: 1 });
      expect(
        r('2026-10-20', 'rezervace')!
          .stranky.map((s) => s.cesta)
          .sort(),
      ).toEqual(['/rezervace/kalendar/posilovna', '/rezervace/platba/:token']);
      expect(r('2026-10-20', 'spolujizda')).toMatchObject({ zobrazeni: 1, navstevnici: 1 });
      // POST přihlášení je jen požadavek, ne zobrazení
      expect(r('2026-10-20', 'ucet')).toMatchObject({ zobrazeni: 0, navstevnici: 0, pozadavky: 1 });
      // celý web: návštěvník dvou sekcí se počítá jednou
      expect(r('2026-10-20', 'celkem')).toMatchObject({ zobrazeni: 9, navstevnici: 2, stazeni: 1, boti: 5 });
      expect(r('2026-10-21', 'celkem')).toMatchObject({ zobrazeni: 3, navstevnici: 1 });
      expect(r('2026-10-21', 'eknihy')!.stranky).toEqual([
        { cesta: '/eknihy/kniha/:id', zobrazeni: 1, navstevnici: 1 },
      ]);
      // žádná IP ani prohlížeč ve výsledku
      expect(JSON.stringify(v)).not.toMatch(/203\.0\.113|Firefox|Mozilla/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('klient s víc než 200 stránkami za den je robot; uzavřený den se znovu neotevře', () => {
    const ag = new Agregator();
    const ua = 'Mozilla/5.0 (Windows NT 10.0) Firefox/128.0';
    const radek = (cas: string, cesta: string, ip = '203.0.113.50') =>
      `[${cas} +0000] - 200 200 - GET https obec.example "${cesta}" [Client ${ip}] [Length 1] [Gzip -] [Sent-to x] "${ua}" "-"`;
    ag.pridej(radek('20/Oct/2026:10:00:00', '/static/css/styl.css'));
    for (let i = 0; i < 201; i++) ag.pridej(radek('20/Oct/2026:10:00:01', `/aktuality/a${i}`));
    ag.pridej(radek('20/Oct/2026:11:00:00', '/static/css/styl.css', '203.0.113.51'));
    ag.pridej(radek('20/Oct/2026:11:00:01', '/kontakt', '203.0.113.51'));
    // o dva dny později → 20. 10. se uzavře; pozdní řádek z něj se zahodí
    ag.pridej(radek('22/Oct/2026:10:00:00', '/', '203.0.113.52'));
    ag.pridej(radek('20/Oct/2026:12:00:00', '/kontakt', '203.0.113.53'));
    expect(ag.pozdnich).toBe(1);
    const den = ag.vysledek().find((x) => x.den === '2026-10-20' && x.sekce === 'celkem')!;
    expect(den).toMatchObject({ navstevnici: 1, zobrazeni: 1, boti: 202 });
  });

  it('graf: sloupce nejvýš 24 jednotek, zakulacený vršek, popisek jen u maxima', () => {
    const serie = Array.from({ length: 7 }, (_, i) => ({
      den: posunDen('2026-10-20', i),
      navstevnici: i * 2,
    }));
    const g = grafNavstevniku(serie, (d) => `${d.den}: ${d.navstevnici}`);
    expect(g.sloupce).toHaveLength(7);
    expect(g.sloupce[0]!.d).toBe(''); // nula = žádný sloupec
    expect(g.sloupce[6]!.d).toMatch(/^M[\d.]+ [\d.]+V[\d.]+Q/);
    expect(g.maximum?.text).toBe('12');
    expect(g.osa).toHaveLength(7);
    const sirky = g.sloupce
      .filter((s) => s.d)
      .map((s) => {
        const m = /^M([\d.]+) .*H([\d.]+)Q([\d.]+)/.exec(s.d)!;
        return Number(m[3]) - Number(m[1]);
      });
    for (const w of sirky) expect(w).toBeLessThanOrEqual(24);
    expect(grafNavstevniku([{ den: '2026-10-20', navstevnici: 0 }], () => '').maximum).toBeNull();
    expect(posunDen('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('veřejná stránka /navstevnost', () => {
  let t: TestApp;
  let adresar: string;
  let posun: number;

  beforeAll(async () => {
    adresar = adresarLogu();
    t = await spustTestApp({
      env: {
        NAVSTEVNOST_LOGY: adresar,
        NAVSTEVNOST_SOUBORY: 'proxy-host-1_access.log*',
        NAVSTEVNOST_VLASTNI_IP: '192.0.2.1',
      },
    });
    await t.db
      .insertInto('web_obsah')
      .values({ typ: 'aktualita', titulek: 'Testovací článek', slug: 'test-clanek', stav: 'zverejneno' })
      .execute();
    await t.db
      .insertInto('web_presmerovani')
      .values({ stara_cesta: '/2024/05/stary-clanek', nova_cesta: '/aktuality/test-clanek' })
      .execute();
    const kat = await t.db.selectFrom('ud_kategorie').select('id').executeTakeFirstOrThrow();
    await t.db
      .insertInto('ud_dokumenty')
      .values({
        id: DESKA_ID,
        nazev: 'Pozvánka na zasedání',
        kategorie_id: kat.id,
        vyveseno_od: new Date('2026-10-01'),
      })
      .execute();
  });
  afterAll(async () => {
    await t?.zavri();
    rmSync(adresar, { recursive: true, force: true });
  });

  it('přepočet uloží jen agregáty a druhý přepočet nepřepíše useknutý nejstarší den', async () => {
    const stav = await t.app.navstevnost!.prepocitej();
    expect(stav).toMatchObject({ souboru: 2, dnu: 2 });
    const den = await t.db
      .selectFrom('navstevnost_den')
      .selectAll()
      .where('den', '=', '2026-10-20')
      .where('sekce', '=', 'celkem')
      .executeTakeFirstOrThrow();
    expect(den).toMatchObject({ navstevnici: 2, zobrazeni: 9, stazeni: 1, boti: 5 });
    const stranky = await t.db.selectFrom('navstevnost_stranky').selectAll().execute();
    expect(JSON.stringify(stranky)).not.toMatch(/203\.0\.113|Mozilla/);

    // po rotaci: nejstarší archiv začíná uprostřed dne 20. 10. — už spočítaný den se nepřepíše
    writeFileSync(
      path.join(adresar, 'proxy-host-1_access.log.1.gz'),
      gzipSync(DEN_A.split('\n').slice(-6).join('\n')),
    );
    await t.app.navstevnost!.prepocitej();
    const znovu = await t.db
      .selectFrom('navstevnost_den')
      .select('zobrazeni')
      .where('den', '=', '2026-10-20')
      .where('sekce', '=', 'celkem')
      .executeTakeFirstOrThrow();
    expect(znovu.zobrazeni).toBe(9);
    writeFileSync(path.join(adresar, 'proxy-host-1_access.log.1.gz'), gzipSync(DEN_A));
  });

  it('stránka ukáže souhrn, graf, názvy stránek s odkazy a filtr sekcí', async () => {
    // data posuneme do posledních dní, ať test nezávisí na dnešním datu
    const dnes = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
    posun = Math.round((Date.parse(dnes) - Date.parse('2026-10-21')) / 86400_000);
    await sql`UPDATE navstevnost_den SET den = den + ${posun}::int`.execute(t.db);
    await sql`UPDATE navstevnost_stranky SET den = den + ${posun}::int`.execute(t.db);

    const p = new Prohlizec(t.base);
    const r = await p.get('/navstevnost?dni=7');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('<h1>Návštěvnost webu</h1>');
    expect(r.text).toMatch(/<dt>Návštěvníci<\/dt><dd>3<\/dd>/); // 2 + 1 (součet za dny)
    expect(r.text).toMatch(/<dt>Zobrazení stránek<\/dt><dd>12<\/dd>/);
    expect(r.text).toContain('role="img"');
    expect(r.text).toContain('class="navst-sloupec"');
    expect(r.text).toContain('href="/aktuality/test-clanek">Testovací článek</a>');
    expect(r.text).toContain('href="/uredni-deska/' + DESKA_ID + '">Pozvánka na zasedání</a>');
    // stará adresa WordPressu → název a odkaz přes přesměrování
    expect(r.text).toMatch(/Testovací článek<\/a><span class="navst-cesta">\/2024\/05\/stary-clanek/);
    expect(r.text).toContain('href="/">Úvodní stránka</a>');
    // zástupce místo tokenu, bez odkazu
    expect(r.text).toContain('/rezervace/platba/:token');
    expect(r.text).not.toContain('0123456789abcdef0123');
    expect(r.text).toContain('aria-current="page">7 dní</a>');
    expect(r.text).toContain('href="/navstevnost?dni=7&amp;sekce=rezervace"');
    expect(r.text).toContain('Jak počítáme');

    const rez = await p.get('/navstevnost?dni=7&sekce=rezervace');
    expect(rez.text).toMatch(/<dt>Zobrazení stránek<\/dt><dd>2<\/dd>/);
    expect(rez.text).not.toContain('Testovací článek');

    // neplatné parametry → výchozí 30 dní, celý web
    const nic = await p.get('/navstevnost?dni=5&sekce=%3Cscript%3E');
    expect(nic.res.status).toBe(200);
    expect(nic.text).toContain('aria-current="page">30 dní</a>');
    expect(nic.text).not.toContain('<script>');
  });

  it('odkaz v patičce pro každého a stránka v mapě webu', async () => {
    const p = new Prohlizec(t.base);
    const uvod = await p.get('/');
    expect(uvod.text).toContain('<a href="/navstevnost" >Návštěvnost webu</a>');
    const mapa = await p.get('/sitemap.xml');
    expect(mapa.text).toContain('/navstevnost</loc>');
  });

  it('bez NAVSTEVNOST_LOGY je modul vypnutý', async () => {
    await t.zavri();
    t = await spustTestApp({ vycistit: false });
    const p = new Prohlizec(t.base);
    expect((await p.get('/navstevnost')).res.status).toBe(404);
    expect((await p.get('/')).text).not.toContain('href="/navstevnost"');
  });
});
