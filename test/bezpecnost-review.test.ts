// Regresní testy k opravám z externího code review: nahrávání (multipart), návraty, blokace, webhook SMS,
// importovaná videa, hlavičky, mezipaměť příloh desky, hesla.
import { promises as fs, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nactiEnv } from '../src/config/env.js';
import { hashujHeslo, overHeslo, potrebujeRehash } from '../src/lib/krypto.js';
import { bezpecnyNavrat, jeBezpecnyOdkaz, jeVlastniCesta } from '../src/lib/navrat.js';
import { cisloStrany } from '../src/lib/vstupy.js';
import { vytvorSmsPoskytovatele } from '../src/lib/sms/index.js';
import type { SmsManager } from '../src/lib/sms/smsmanager.js';
import { najdiVidea } from '../src/moduly/web/import/html-pomoc.js';
import { Importer } from '../src/moduly/web/import/importer.js';
import type { ImportniZdroj, Stahovac } from '../src/moduly/web/import/typy.js';
import { tajemstviWebhooku } from '../src/moduly/infokanal/index.js';
import { uklidTmp } from '../src/web/nahravani.js';
import { datumPraha } from '../src/lib/datum.js';
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
let tmp: string;
beforeAll(async () => {
  t = await spustTestApp();
  tmp = path.join(path.resolve(t.app.env.DATA_DIR), 'tmp');
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const obsahTmp = async () => (await fs.readdir(tmp)).sort();

describe('nahrávání souborů jen pro správu', () => {
  const soubor = { pole: 'soubor', nazev: 'velky.bin', data: Buffer.alloc(256 * 1024, 7) };

  it('anonym s multipart na veřejný POST: 4xx a nic na disku', async () => {
    const pred = await obsahTmp();
    for (const url of ['/odhlaseni', '/infokanal', '/sprava/web/galerie', '/sprava/deska/novy']) {
      const r = await postSoubory(new Prohlizec(t.base), url, { _csrf: 'x' }, [soubor, soubor], false);
      expect(r.res.status, url).toBeGreaterThanOrEqual(400);
      expect(r.res.status, url).toBeLessThan(500);
    }
    expect(await obsahTmp()).toEqual(pred);
  });

  it('občan bez role ani redaktor desky nenahrají do správy webu', async () => {
    const pred = await obsahTmp();
    const obcan = await prihlasSRoli(t, '777 610 001', []);
    const deska = await prihlasSRoli(t, '777 610 002', ['deska']);
    for (const p of [obcan, deska]) {
      const r = await postSoubory(p, '/sprava/web/videa', { _csrf: 'x' }, [soubor], false);
      expect(r.res.status).toBe(403);
    }
    // ani přihlášený nesmí nahrávat mimo správu
    const r = await postSoubory(obcan, '/ucet', { _csrf: 'x' }, [soubor], false);
    expect(r.res.status).toBe(415);
    expect(await obsahTmp()).toEqual(pred);
  });

  it('požadavek z cizího webu (Sec-Fetch-Site: cross-site) je odmítnut ještě před čtením těla', async () => {
    const red = await prihlasSRoli(t, '777 610 003', ['web']);
    red.hlavicky = { 'sec-fetch-site': 'cross-site' };
    const r = await postSoubory(red, '/sprava/web/galerie', { _csrf: 'x' }, [soubor], false);
    expect(r.res.status).toBe(403);
  });

  it('redaktor webu nahrávat smí a dočasné soubory po odpovědi zmizí', async () => {
    const red = await prihlasSRoli(t, '777 610 004', ['web']);
    const form = await red.get('/sprava/web/dokumenty');
    const pred = await obsahTmp();
    const r = await postSoubory(
      red,
      '/sprava/web/dokumenty',
      { _csrf: csrfZ(form.text), nazev: 'Řád', skupina: '' },
      [{ pole: 'soubor', nazev: 'rad.pdf', data: MALE_PDF, typ: 'application/pdf' }],
      false,
    );
    expect(r.res.status).toBe(302);
    // úklid běží v onResponse, tedy až po odeslání odpovědi
    for (let i = 0; i < 20 && (await obsahTmp()).length !== pred.length; i++)
      await new Promise((h) => setTimeout(h, 50));
    expect(await obsahTmp()).toEqual(pred);
  });

  it('úklid tmp maže jen staré soubory', async () => {
    const adr = path.join(tmp, '..', 'tmp-test-uklid');
    await fs.mkdir(adr, { recursive: true });
    writeFileSync(path.join(adr, 'stary'), 'x');
    writeFileSync(path.join(adr, 'novy'), 'x');
    const pred10h = (Date.now() - 10 * 3600_000) / 1000;
    utimesSync(path.join(adr, 'stary'), pred10h, pred10h);
    expect(await uklidTmp(adr)).toBe(1);
    expect(await fs.readdir(adr)).toEqual(['novy']);
    await fs.rm(adr, { recursive: true, force: true });
  });
});

describe('návrat po akci (open redirect)', () => {
  it('helper pustí jen vlastní cesty', () => {
    for (const zle of [
      '/\\cizi.example',
      '\\\\cizi.example',
      '//cizi.example',
      '/\\/cizi.example',
      '/\t/cizi.example',
      'https://cizi.example',
      'javascript:alert(1)',
      '',
    ])
      expect(jeVlastniCesta(zle), zle).toBe(false);
    expect(jeVlastniCesta('/ucet?x=1')).toBe(true);
    expect(jeVlastniCesta('/%5Ccizi')).toBe(true); // zakódované lomítko je jen text v cestě
    expect(bezpecnyNavrat('/\\cizi.example', '/ucet')).toBe('/ucet');
    expect(bezpecnyNavrat(['/a'] as unknown, '/x')).toBe('/x');
    expect(jeBezpecnyOdkaz('https://obec.example/a')).toBe(true);
    expect(jeBezpecnyOdkaz('/\\cizi.example')).toBe(false);
    expect(jeBezpecnyOdkaz('javascript:alert(1)')).toBe(false);
    expect(jeBezpecnyOdkaz('https://a b')).toBe(false);
  });

  it('/velikost a /prihlaseni nevrátí na cizí server (\\ i //)', async () => {
    for (const zpet of ['/\\cizi.example', '//cizi.example', '/\\/cizi.example']) {
      const r = await fetch(`${t.base}/velikost?v=a&zpet=${encodeURIComponent(zpet)}`, {
        redirect: 'manual',
      });
      expect(r.headers.get('location'), zpet).toBe('/');
    }
    const p = await prihlasSRoli(t, '777 610 010', []);
    for (const zpet of ['/\\cizi.example', '//cizi.example']) {
      const r = await p.get(`/prihlaseni?zpet=${encodeURIComponent(zpet)}`, false);
      expect(r.res.headers.get('location'), zpet).toBe('/ucet');
    }
  });

  it('přesměrování starých adres nepřijme /\\cizi', async () => {
    const sp = await prihlasSRoli(t, '777 610 011', ['spravce']);
    const form = await sp.get('/sprava/web/presmerovani');
    await sp.post('/sprava/web/presmerovani', {
      _csrf: csrfZ(form.text),
      stara: '/stara-zla',
      nova: '/\\cizi.example',
    });
    const r = await fetch(`${t.base}/stara-zla`, { redirect: 'manual' });
    expect(r.status).toBe(404);
  });
});

describe('blokace účtů', () => {
  it('správce nezablokuje admina ani sebe; admin správce ano', async () => {
    const admin = await prihlasSRoli(t, '777 620 001', ['admin']);
    const spravce = await prihlasSRoli(t, '777 620 002', ['spravce']);
    const id = async (tel: string) =>
      (await t.db.selectFrom('uzivatele').selectAll().where('telefon', '=', tel).executeTakeFirstOrThrow())
        .id;
    const idAdmin = await id('+420777620001');
    const idSpravce = await id('+420777620002');
    const blokuj = async (p: Prohlizec, cil: string) => {
      const d = await p.get(`/sprava/uzivatele/${cil}`);
      // tlačítko blokace se tomu, kdo nesmí, ani neukáže → token vezmeme z jiného formuláře
      await p.post(`/sprava/uzivatele/${cil}`, { _csrf: csrfZ(d.text), akce: 'blokovat' });
      return d.text;
    };
    const stav = async (cil: string) =>
      (
        await t.db
          .selectFrom('uzivatele')
          .select('blokovan_at')
          .where('id', '=', cil)
          .executeTakeFirstOrThrow()
      ).blokovan_at;

    const detail = await blokuj(spravce, idAdmin);
    expect(detail).not.toContain('value="blokovat"');
    expect(await stav(idAdmin)).toBeNull();
    await blokuj(spravce, idSpravce);
    expect(await stav(idSpravce)).toBeNull();
    await blokuj(admin, idAdmin); // ani admin sám sebe
    expect(await stav(idAdmin)).toBeNull();
    await blokuj(admin, idSpravce);
    expect(await stav(idSpravce)).not.toBeNull();
  });

  it('nesmyslné id ve správě = 404, ne 500', async () => {
    const sp = await prihlasSRoli(t, '777 620 003', ['spravce']);
    expect((await sp.get('/sprava/web/obsah/neni-uuid')).res.status).toBe(404);
    expect((await sp.get('/sprava/deska/neni-uuid')).res.status).toBe(404);
  });
});

describe('webhook doručenek SMS', () => {
  it('tajemství je odvozené (ne kus SESSION_SECRET), staré odmítne, porovnání funguje', async () => {
    const tajne = tajemstviWebhooku(t.app.env);
    expect(t.app.env.SESSION_SECRET).not.toContain(tajne);
    expect(tajne.length).toBeGreaterThanOrEqual(32);
    expect(
      tajemstviWebhooku({ SESSION_SECRET: 'x'.repeat(40), SMS_WEBHOOK_TOKEN: 'vlastni-token-24-znaku-a' }),
    ).toBe('vlastni-token-24-znaku-a');
    const posli = (s: string) =>
      fetch(`${t.base}/webhook/sms/${s}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      });
    expect((await posli(t.app.env.SESSION_SECRET.slice(0, 24))).status).toBe(404);
    expect((await posli(tajne.slice(0, -1))).status).toBe(404);
    expect((await posli(tajne)).status).toBe(200);
  });

  it('SMS Manager: podpis z SMSMANAGER_WEBHOOK_SECRET se ověřuje nad surovým tělem', async () => {
    const env = nactiEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'a'.repeat(64),
      OIDC_COOKIE_SECRET: 'b'.repeat(64),
      OIDC_PLATFORMA_SECRET: 'c'.repeat(32),
      SMS_PROVIDER: 'smsmanager',
      SMSMANAGER_APIKEY: 'k',
      SMSMANAGER_WEBHOOK_SECRET: 'podpis-tajny',
    });
    const sms = vytvorSmsPoskytovatele(env, t.app.log) as SmsManager;
    const telo = '[{"message_id":"m1","result":"delivered"}]';
    const podpis = createHmac('sha256', 'podpis-tajny').update(telo).digest('hex');
    await expect(sms.zpracujWebhook(telo, { 'x-request-signature': 'f'.repeat(64) })).rejects.toThrow();
    expect(await sms.zpracujWebhook(telo, { 'x-request-signature': podpis })).toEqual([
      { branaId: 'm1', stav: 'doruceno' },
    ]);

    // přes HTTP: route předá surové tělo, takže podpis sedí; špatný podpis = 400
    const app = t.app as unknown as { sms: unknown };
    const puvodni = app.sms;
    app.sms = sms;
    try {
      const url = `${t.base}/webhook/sms/${tajemstviWebhooku(t.app.env)}`;
      const spatne = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-signature': '0'.repeat(64) },
        body: telo,
      });
      expect(spatne.status).toBe(400);
      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-signature': podpis },
        body: telo,
      });
      expect(ok.status).toBe(200);
    } finally {
      app.sms = puvodni;
    }
  });

  it('ostrá instalace s konzolí místo SMS brány se nespustí', () => {
    const zaklad = {
      DATABASE_URL: 'postgres://x',
      SESSION_SECRET: 'a'.repeat(64),
      OIDC_COOKIE_SECRET: 'b'.repeat(64),
      OIDC_PLATFORMA_SECRET: 'c'.repeat(32),
    };
    expect(() => nactiEnv({ ...zaklad, NODE_ENV: 'production', SMS_PROVIDER: 'konzole' })).toThrow(/konzole/);
    expect(() =>
      nactiEnv({ ...zaklad, NODE_ENV: 'production', SMS_PROVIDER: 'konzole', OTP_DEV_ZOBRAZIT: '1' }),
    ).not.toThrow();
  });
});

describe('import: video s javascript: adresou', () => {
  const ZLE = [
    '<video src="javascript:alert(1)//x.mp4"></video>',
    '<video><source src="javascript:alert(2)//x.mp4"></video>',
    '[video mp4="javascript:alert(3)//x.mp4"][/video]',
    '[embed]javascript:alert(4)//x.mp4[/embed]',
  ];

  it('najdiVidea z ní video neudělá', () => {
    for (const html of ZLE) expect(najdiVidea(html, 'https://stara.example').videa, html).toEqual([]);
  });

  it('importovaný obsah neobsahuje javascript: ani po dosazení značek videí', async () => {
    const Z = 'https://stara.example';
    const stahovac: Stahovac = {
      stazeno: 0,
      async text() {
        return '';
      },
      async json() {
        throw new Error('ne');
      },
      async soubor() {
        return null;
      },
    };
    const zdroj: ImportniZdroj = {
      nazev: 'test',
      zaklad: Z,
      async *stranky() {
        yield {
          klic: 'js',
          url: `${Z}/zla-videa/`,
          titulek: 'Zlá videa',
          html: `<p>Úvod</p>${ZLE.join('')}`,
        };
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
    await imp.spust();
    const o = await t.db
      .selectFrom('web_obsah')
      .select('obsah_html')
      .where('puvodni_url', '=', `${Z}/zla-videa/`)
      .executeTakeFirstOrThrow();
    expect(o.obsah_html).toContain('Úvod');
    // nevykreslený shortcode smí zůstat jako prostý text, ale nikdy jako adresa odkazu / zdroje
    expect(o.obsah_html).not.toMatch(/(href|src)\s*=\s*["']?\s*javascript:/i);
    expect(o.obsah_html).not.toMatch(/<(video|a)\b[^>]*javascript:/i);
    // přímé volání: video z adresy, která není http(s), se nezaloží ani jako odkaz
    expect(await imp.video({ zdroj: 'soubor', url: 'javascript:alert(5)//x.mp4' }, 'x')).toBe('');
  });
});

describe('hlavičky a mezipaměť', () => {
  it('odpovědi OIDC provideru mají bezpečnostní hlavičky', async () => {
    const r = await fetch(`${t.base}/oidc/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });

  it('healthz neprozradí detail chyby', async () => {
    const r = await fetch(`${t.base}/healthz`);
    expect(Object.keys(await r.json())).not.toContain('db');
  });

  it('chyba z OIDC callbacku se nezobrazí doslova', async () => {
    const p = new Prohlizec(t.base);
    await p.get('/prihlaseni', false); // založí stav přihlášení v sezení
    const r = await p.get('/prihlaseni/callback?error=x&error_description=Zavolejte%20na%20900123456');
    expect(r.text).not.toContain('900123456');
    expect(r.text).toContain('Přihlášení se nepovedlo');
  });

  it('?strana nesmysl = první strana, ne 500', async () => {
    expect(cisloStrany('1.1')).toBe(1);
    expect(cisloStrany('Infinity')).toBe(1);
    expect(cisloStrany('-2')).toBe(1);
    expect(cisloStrany('3')).toBe(3);
    for (const url of [
      '/aktuality?strana=1.1',
      '/aktuality?strana=Infinity',
      '/uredni-deska/archiv?strana=-1&rok=1e9',
    ])
      expect((await fetch(t.base + url)).status, url).toBe(200);
  });

  it('příloha desky: veřejná krátce, neveřejná vůbec do mezipaměti', async () => {
    const red = await prihlasSRoli(t, '777 630 001', ['deska']);
    const form = await red.get('/sprava/deska/novy');
    const kat = await t.db.selectFrom('ud_kategorie').select('id').executeTakeFirstOrThrow();
    await postSoubory(
      red,
      '/sprava/deska/novy',
      {
        _csrf: csrfZ(form.text),
        nazev: 'Mezipaměť test',
        kategorie_id: String(kat.id),
        od: datumPraha(new Date()),
      },
      [{ pole: 'prilohy', nazev: 'priloha.pdf', data: MALE_PDF, typ: 'application/pdf' }],
    );
    const d = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Mezipaměť test')
      .executeTakeFirstOrThrow();
    const pr = await t.db
      .selectFrom('ud_prilohy')
      .select('soubor_id')
      .where('dokument_id', '=', d.id)
      .executeTakeFirstOrThrow();
    const url = `${t.base}/soubory/${pr.soubor_id}/priloha.pdf`;
    expect((await fetch(url)).headers.get('cache-control')).toBe('public, max-age=300');
    await t.db.updateTable('ud_dokumenty').set({ smazano_at: new Date() }).where('id', '=', d.id).execute();
    expect((await fetch(url)).status).toBe(404);
    const proUrad = await red.get(`/soubory/${pr.soubor_id}/priloha.pdf`);
    expect(proUrad.res.status).toBe(200);
    expect(proUrad.res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('hesla', () => {
  it('nové hashe mají aktuální parametry, staré se ověří a označí k přepočtu', async () => {
    const h = await hashujHeslo('tajne-heslo-1');
    expect(h.split('$')).toHaveLength(6);
    expect(await overHeslo('tajne-heslo-1', h)).toBe(true);
    expect(potrebujeRehash(h)).toBe(false);
    // starý formát scrypt$N$sůl$hash (N=2^14, r=8, p=1)
    const { scryptSync } = await import('node:crypto');
    const stary = `scrypt$16384$abcd$${scryptSync('stare', 'abcd', 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
    expect(await overHeslo('stare', stary)).toBe(true);
    expect(await overHeslo('jine', stary)).toBe(false);
    expect(potrebujeRehash(stary)).toBe(true);
    // poškozený záznam s obřím N se nepočítá
    expect(await overHeslo('x', 'scrypt$1073741824$abcd$00')).toBe(false);
  });

  it('přihlášení heslem přepočítá starý hash', async () => {
    const { scryptSync } = await import('node:crypto');
    const stary = `scrypt$32768$beef$${scryptSync('heslo-stare-1', 'beef', 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
    await t.db
      .insertInto('uzivatele')
      .values({ telefon: '+420777640001', email: 'rehash@example.cz', heslo_hash: stary, role: [] as never })
      .execute();
    expect(await t.app.ucty.prihlasHeslem('rehash@example.cz', 'heslo-stare-1')).not.toBeNull();
    const u = await t.db
      .selectFrom('uzivatele')
      .select('heslo_hash')
      .where('email', '=', 'rehash@example.cz')
      .executeTakeFirstOrThrow();
    expect(u.heslo_hash).not.toBe(stary);
    expect(potrebujeRehash(u.heslo_hash!)).toBe(false);
    expect(await t.app.ucty.prihlasHeslem('rehash@example.cz', 'heslo-stare-1')).not.toBeNull();
    expect(await t.app.ucty.prihlasHeslem('neni@example.cz', 'heslo-stare-1')).toBeNull();
  });
});
