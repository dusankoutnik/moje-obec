// Formulář hlášení (kopírování mezi kanály, editor e-mailu, přílohy), tlačítko „Vytvořit zprávu“ v editoru
// příspěvku, název infokanálu ze Vzhledu a počet obyvatel z administrace.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfZ, MALE_PDF, prihlasSRoli, postSoubory, spustTestApp, type TestApp } from './pomocnici.js';
import { htmlNaTextEmailu, prilohyEmailem, zpracujEmail } from '../src/moduly/infokanal/obsah.js';
import { cteniObyvatel } from '../src/moduly/web/obyvatele.js';
import { ObecSchema } from '../src/config/obec.js';
import { PRAZDNA_POLE } from '../src/moduly/web/obsah.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
  await t.db
    .insertInto('ik_odberatele')
    .values({
      jmeno: 'Eva E-mailová',
      telefon: null,
      email: 'eva@example.cz',
      cast_obce: '',
      kanal: 'email',
      token: 'tok-eva',
      zdroj: 'urad',
      overen_at: new Date(),
    })
    .execute();
});
afterAll(async () => t.zavri());

async function kategorieId(slug: string) {
  return (
    await t.db.selectFrom('ik_kategorie').select('id').where('slug', '=', slug).executeTakeFirstOrThrow()
  ).id;
}

describe('obsah hlášení (čisté funkce)', () => {
  it('HTML z editoru → text e-mailu s odkazy a odrážkami, relativní odkazy absolutně', () => {
    const v = zpracujEmail(
      '<p>Ahoj <strong>všichni</strong>, viz <a href="/aktuality/x">článek</a>.</p><ol><li>jedna</li><li>dvě</li></ol><ul><li>bod</li></ul><script>x()</script>',
      'https://obec.example',
    );
    expect(v.html).toContain('<a href="https://obec.example/aktuality/x">článek</a>');
    expect(v.html).not.toContain('script');
    expect(v.text).toContain('článek (https://obec.example/aktuality/x)');
    expect(v.text).toContain('1. jedna');
    expect(v.text).toContain('2. dvě');
    expect(v.text).toContain('• bod');
    expect(zpracujEmail('Jen text\n\nbez značek', 'https://x').html).toBeNull();
    expect(htmlNaTextEmailu('<p><a href="https://a.cz">https://a.cz</a></p>')).toBe('https://a.cz');
  });

  it('přílohy jdou k e-mailu jen do 5 MB dohromady', () => {
    const p = (velikost: number) => ({ id: 'x', nazev: 'a.pdf', velikost, mime: 'application/pdf' });
    expect(prilohyEmailem([])).toBe(false);
    expect(prilohyEmailem([p(1000), p(2000)])).toBe(true);
    expect(prilohyEmailem([p(4 * 1024 * 1024), p(2 * 1024 * 1024)])).toBe(false);
  });

  it('počet obyvatel z formuláře', () => {
    expect(cteniObyvatel('')).toBeNull();
    expect(cteniObyvatel(' 1 234 ')).toBe(1234);
    expect(cteniObyvatel('0')).toBe('neplatne');
    expect(cteniObyvatel('1000001')).toBe('neplatne');
    expect(cteniObyvatel('12,5')).toBe('neplatne');
    expect(cteniObyvatel('abc')).toBe('neplatne');
  });
});

describe('formulář nového hlášení', () => {
  it('kopírovací tlačítka, editor, přílohy: e-mail s přílohou a odkazem, článek s přílohami', async () => {
    const p = await prihlasSRoli(t, '777 620 001', ['redaktor', 'web']);
    const f = await p.get('/infokanal/sprava/nove');
    expect(f.text).toContain('enctype="multipart/form-data"');
    expect(f.text).toContain('data-kopirovat="sms" data-do="email_text"');
    expect(f.text).toContain('data-kopirovat="email_text" data-do="clanek_text"');
    expect(f.text).toContain('data-kopirovat="email_predmet" data-do="clanek_titulek"');
    expect(f.text).toContain('data-editor="zakladni"');
    expect(f.text).toContain('type="file"');
    expect(f.text).toContain('/static/js/hlaseni.js');

    const mailPred = t.mail.odeslane.length;
    const r = await postSoubory(
      p,
      '/infokanal/sprava/nove',
      {
        _csrf: csrfZ(f.text),
        kategorie_id: String(await kategorieId('hlaseni')),
        cil: 'vse',
        email_predmet: 'Svoz odpadu',
        email_text: '<p>Svoz bude <strong>v sobotu</strong>, viz <a href="/uredni-deska">deska</a>.</p>',
        clanek_titulek: 'Svoz odpadu v sobotu',
        clanek_text: '<p>Svoz bude v sobotu.</p>',
      },
      [{ pole: 'prilohy', nazev: 'harmonogram.pdf', data: MALE_PDF, typ: 'application/pdf' }],
    );
    expect(r.url).toMatch(/\/infokanal\/sprava\/hlaseni\//);
    expect(r.text).toContain('harmonogram.pdf');
    const h = await t.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .orderBy('vytvoreno_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(h.prilohy).toHaveLength(1);
    expect(h.prilohy[0]!.nazev).toBe('harmonogram.pdf');
    expect(h.email_html).toContain('<strong>v sobotu</strong>');
    expect(h.email_text).toContain(`deska (${t.base}/uredni-deska)`);
    await t.app.infokanalFronta.zpracujVse();
    const mail = t.mail.odeslane.slice(mailPred).find((m) => m.komu === 'eva@example.cz')!;
    expect(mail).toBeTruthy();
    expect(mail.prilohy?.map((x) => x.nazev)).toEqual(['harmonogram.pdf']);
    expect(mail.prilohy![0]!.cesta).toContain(h.prilohy[0]!.id);
    expect(mail.text).toContain(`${t.base}/soubory/${h.prilohy[0]!.id}/harmonogram.pdf`);
    expect(mail.html).toContain(`href="${t.base}/soubory/${h.prilohy[0]!.id}/harmonogram.pdf"`);
    expect(mail.html).toContain('<strong>v sobotu</strong>');
    // článek na webu: přílohy pod textem
    const clanek = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Svoz odpadu v sobotu')
      .executeTakeFirstOrThrow();
    expect(clanek.obsah_html).toContain(
      `<a href="/soubory/${h.prilohy[0]!.id}/harmonogram.pdf">harmonogram.pdf</a>`,
    );
  });

  it('po chybě zůstanou nahrané přílohy; cizí soubor přes priloha_id nejde; nepovolený typ se odmítne', async () => {
    const p = await prihlasSRoli(t, '777 620 002', ['redaktor']);
    const f = await p.get('/infokanal/sprava/nove');
    // SMS moc dlouhá → formulář se vrátí, příloha zůstane jako skryté pole
    const r = await postSoubory(
      p,
      '/infokanal/sprava/nove',
      {
        _csrf: csrfZ(f.text),
        kategorie_id: String(await kategorieId('hlaseni')),
        cil: 'vse',
        sms_text: 'x'.repeat(470),
        email_predmet: 'Předmět',
        email_text: 'Text',
      },
      [{ pole: 'prilohy', nazev: 'pozvanka.pdf', data: MALE_PDF, typ: 'application/pdf' }],
    );
    expect(r.text).toContain('Text SMS je příliš dlouhý');
    const id = /name="priloha_id" value="([0-9a-f-]{36})"/.exec(r.text)?.[1];
    expect(id).toBeTruthy();
    // jiný redaktor nemůže cizí soubor přibalit
    const jiny = await prihlasSRoli(t, '777 620 003', ['redaktor']);
    const f2 = await jiny.get('/infokanal/sprava/nove');
    const r2 = await jiny.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(f2.text),
      kategorie_id: String(await kategorieId('hlaseni')),
      cil: 'vse',
      email_predmet: 'Cizí příloha',
      email_text: 'Text',
      priloha_id: id!,
    });
    expect(r2.url).toMatch(/\/infokanal\/sprava\/hlaseni\//);
    const h2 = await t.db
      .selectFrom('ik_hlaseni')
      .select('prilohy')
      .where('email_predmet', '=', 'Cizí příloha')
      .executeTakeFirstOrThrow();
    expect(h2.prilohy).toEqual([]);
    // autor ji po opravě odešle (bez nového nahrání)
    const r3 = await p.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(r.text),
      kategorie_id: String(await kategorieId('hlaseni')),
      cil: 'vse',
      email_predmet: 'Opravené',
      email_text: 'Text',
      priloha_id: id!,
    });
    expect(r3.url).toMatch(/\/infokanal\/sprava\/hlaseni\//);
    const h3 = await t.db
      .selectFrom('ik_hlaseni')
      .select('prilohy')
      .where('email_predmet', '=', 'Opravené')
      .executeTakeFirstOrThrow();
    expect(h3.prilohy.map((x) => x.id)).toEqual([id]);
    // spustitelný soubor se nenahraje
    const f4 = await p.get('/infokanal/sprava/nove');
    const r4 = await postSoubory(
      p,
      '/infokanal/sprava/nove',
      {
        _csrf: csrfZ(f4.text),
        kategorie_id: String(await kategorieId('hlaseni')),
        cil: 'vse',
        email_predmet: 'Typ',
        email_text: 'Text',
      },
      [
        {
          pole: 'prilohy',
          nazev: 'virus.exe',
          data: Buffer.from('MZ\x90\x00binary'),
          typ: 'application/x-msdownload',
        },
      ],
    );
    expect(r4.text).toContain('Tento typ souboru nejde nahrát');
  });

  it('bez role redaktor multipart na formulář nepustí', async () => {
    const p = await prihlasSRoli(t, '777 620 004', ['web']);
    const r = await postSoubory(p, '/infokanal/sprava/nove', { _csrf: 'x' }, [
      { pole: 'prilohy', nazev: 'a.pdf', data: MALE_PDF, typ: 'application/pdf' },
    ]);
    expect(r.res.status).toBe(403);
  });
});

describe('tlačítko Vytvořit zprávu v editoru příspěvku', () => {
  it('zveřejněný: odkaz s předvyplněním (HTML e-mailu); koncept a nový: neaktivní s vysvětlením', async () => {
    const autor = (await t.db.selectFrom('uzivatele').select('id').limit(1).executeTakeFirstOrThrow()).id;
    const zverejnenyId = await t.app.web.obsah.uloz(
      null,
      'aktualita',
      {
        ...PRAZDNA_POLE,
        titulek: 'Uzavírka silnice',
        perex: 'Silnice bude zavřená.',
        obsah_html: '<p>Text</p>',
      },
      'zverejnit',
      autor,
      null,
    );
    const konceptId = await t.app.web.obsah.uloz(
      null,
      'aktualita',
      { ...PRAZDNA_POLE, titulek: 'Rozpracovaná zpráva', obsah_html: '<p>Text</p>' },
      'koncept',
      autor,
      null,
    );
    const p = await prihlasSRoli(t, '777 620 005', ['redaktor', 'web']);
    const e1 = await p.get(`/sprava/web/obsah/${zverejnenyId}`);
    expect(e1.text).toContain(`href="/infokanal/sprava/nove?obsah=${zverejnenyId}"`);
    expect(e1.text).toContain('Vytvořit zprávu (TestKanál)');
    const e2 = await p.get(`/sprava/web/obsah/${konceptId}`);
    expect(e2.text).not.toContain(`?obsah=${konceptId}`);
    expect(e2.text).toMatch(/<button class="tlacitko sekundarni plna-sirka" type="button" disabled/);
    expect(e2.text).toContain('až bude příspěvek zveřejněný');
    const novy = await p.get('/sprava/web/novy?typ=aktualita');
    expect(novy.text).toContain('až bude příspěvek zveřejněný');
    // předvyplnění: e-mail jako HTML pro editor
    const f = await p.get(`/infokanal/sprava/nove?obsah=${zverejnenyId}`);
    expect(f.text).toMatch(/<textarea id="email_text"[^>]*>&lt;p&gt;Silnice bude zavřená/);
  });
});

describe('název infokanálu (Správa → Vzhled)', () => {
  it('výchozí „Hlášení obce“, obec.yml, pak Vzhled — menu, nadpisy, Můj účet, e-mail', async () => {
    expect(ObecSchema.shape.texty.parse({}).nazev_infokanalu).toBe('Hlášení obce');
    const pred = await (await fetch(`${t.base}/infokanal`)).text();
    expect(pred).toContain('<h1>TestKanál</h1>');
    // položka menu webu s dosavadním názvem se přejmenuje, vlastní název jiné položky zůstane
    await t.app.web.obsah.uloz(
      null,
      'odkaz',
      { ...PRAZDNA_POLE, titulek: 'TestKanál', odkaz_url: '/infokanal' },
      'zverejnit',
      null,
    );
    await t.app.web.obsah.uloz(
      null,
      'odkaz',
      { ...PRAZDNA_POLE, titulek: 'SMS zprávy', odkaz_url: '/infokanal/' },
      'zverejnit',
      null,
    );
    const buh = await prihlasSRoli(t, '777 620 006', ['provozovatel']);
    const v = await buh.get('/sprava/web/vzhled');
    expect(v.text).toContain('id="nazev_infokanalu"');
    const ulozeno = await buh.post('/sprava/web/vzhled', {
      _csrf: csrfZ(v.text),
      akce: 'ulozit',
      nazev: 'Testov',
      nazev_infokanalu: '  Testovský   kanál ',
    });
    expect(ulozeno.res.status).toBe(200);
    const po = await (await fetch(`${t.base}/infokanal`)).text();
    expect(po).toContain('<h1>Testovský kanál</h1>');
    expect(po).toMatch(/href="\/infokanal"[^>]*>Testovský kanál</);
    expect(po).toContain('SMS zprávy');
    const sprava = await buh.get('/infokanal/sprava');
    expect(sprava.text).toContain('Testovský kanál — ');
    const ucet = await buh.get('/ucet');
    expect(ucet.text).toContain('(Testovský kanál)');
    // patička e-mailu hlášení
    const red = await prihlasSRoli(t, '777 620 007', ['redaktor']);
    const f = await red.get('/infokanal/sprava/nove');
    const mailPred = t.mail.odeslane.length;
    await red.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(f.text),
      kategorie_id: String(await kategorieId('hlaseni')),
      cil: 'vse',
      email_predmet: 'Test názvu',
      email_text: 'Text',
    });
    await t.app.infokanalFronta.zpracujVse();
    const mail = t.mail.odeslane.slice(mailPred).find((m) => m.predmet === 'Test názvu')!;
    expect(mail.text).toContain('Testovský kanál — ');
    expect(mail.html).toContain('Testovský kanál — ');
    // prázdné pole = zpět na obec.yml
    const v2 = await buh.get('/sprava/web/vzhled');
    await buh.post('/sprava/web/vzhled', {
      _csrf: csrfZ(v2.text),
      akce: 'ulozit',
      nazev: 'Testov',
      nazev_infokanalu: '',
    });
    expect(await (await fetch(`${t.base}/infokanal`)).text()).toContain('<h1>TestKanál</h1>');
  });

  it('název „VlastiKanál“ není v šablonách ani textech natvrdo', () => {
    const koren = path.join(import.meta.dirname, '..');
    const soubory: string[] = [];
    const projdi = (d: string) => {
      for (const n of readdirSync(d)) {
        const c = path.join(d, n);
        if (statSync(c).isDirectory()) projdi(c);
        else if (/\.(eta|js)$/.test(n) || c.endsWith(path.join('i18n', 'cs.ts'))) soubory.push(c);
      }
    };
    projdi(path.join(koren, 'views'));
    projdi(path.join(koren, 'public', 'js'));
    projdi(path.join(koren, 'src', 'i18n'));
    const s = soubory.filter((c) => /vlastikan/i.test(readFileSync(c, 'utf8')));
    expect(s).toEqual([]);
  });
});

describe('počet obyvatel z administrace', () => {
  it('správce uloží, titulka ho ukáže, prázdné zruší; redaktor webu pole nevidí ani neuloží', async () => {
    const red = await prihlasSRoli(t, '777 620 008', ['web']);
    const w = await red.get('/sprava/web');
    expect(w.text).not.toContain('id="pocet_obyvatel"');
    expect(w.text).toContain('href="/sprava/web/aktuality"');
    const zakaz = await red.post('/sprava/web/obyvatele', { _csrf: csrfZ(w.text), pocet: '500' }, false);
    expect(zakaz.res.status).toBe(403);

    t.app.obec.obec.fakta = [{ hodnota: '357', popisek: 'obyvatel', odkaz: '/obec' }];
    const sp = await prihlasSRoli(t, '777 620 009', ['spravce']);
    const s1 = await sp.get('/sprava/web');
    expect(s1.text).toContain('<label for="pocet_obyvatel"><strong>Počet obyvatel</strong></label>');
    expect(s1.text).toContain('placeholder="357"');
    // Aktuality a počet obyvatel jsou dvě samostatné dlaždice (27. 10.)
    expect(s1.text).toContain('<a class="dlazdice" href="/sprava/web/aktuality">');
    expect(s1.text).toMatch(/<div class="dlazdice dlazdice-s-polem" id="obyvatele">/);
    const spatne = await sp.post('/sprava/web/obyvatele', { _csrf: csrfZ(s1.text), pocet: 'hodně' });
    expect(spatne.text).toContain('celé číslo od 1 do 1 000 000');
    const ok = await sp.post('/sprava/web/obyvatele', { _csrf: csrfZ(spatne.text), pocet: '1 420' });
    expect(ok.text).toContain('Počet obyvatel uložen: 1420');
    expect(ok.text).toContain('value="1420"');
    const uvod = await (await fetch(`${t.base}/`)).text();
    expect(uvod).toMatch(/data-cislo="1420"/);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'web.obyvatele')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ pred: null, po: 1420 });
    const zrus = await sp.post('/sprava/web/obyvatele', { _csrf: csrfZ(ok.text), pocet: '' });
    expect(zrus.text).toContain('Ruční počet obyvatel zrušen');
    expect(await (await fetch(`${t.base}/`)).text()).toMatch(/data-cislo="357"/);
  });
});
