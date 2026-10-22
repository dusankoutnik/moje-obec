// Text dokumentů přes HTTP a DB: zařazení při nahrání, worker, hledání s úryvkem a odkazem na místo na webu,
// soukromí (neveřejné přílohy se nehledají), správa fronty (jednotlivě i hromadně, audit, role), dashboard,
// opakování chyb, zaseknuté řádky, rychlá kontrola PDF. OCR a pdftotext jen tam, kde jsou binárky.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datumPraha } from '../src/lib/datum.js';
import { dostupneNastroje } from '../src/lib/text-souboru.js';
import {
  csrfZ,
  docxSTextem,
  postSoubory,
  prihlasSRoli,
  Prohlizec,
  spustTestApp,
  type TestApp,
} from './pomocnici.js';

const FIXTURES = new URL('./fixtures/text/', import.meta.url).pathname;
const nastroje = await dostupneNastroje();
const maPoppler = nastroje.pdftotext && nastroje.pdfinfo && nastroje.pdftoppm;
const maOcr = maPoppler && nastroje.tesseract;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let t: TestApp;
let p: Prohlizec;
const verejne = () => new Prohlizec(t.base);

beforeAll(async () => {
  t = await spustTestApp();
  p = await prihlasSRoli(t, '+420777600001', ['web', 'deska']);
});
afterAll(async () => t.zavri());

const fronta = () => t.app.textSouboru;
const radek = (id: string) =>
  t.db.selectFrom('soubory_text').selectAll().where('soubor_id', '=', id).executeTakeFirst();

/** vyvěsí dokument desky s přílohami; vrací id dokumentu a id příloh */
async function vyvesit(
  nazev: string,
  soubory: Parameters<typeof postSoubory>[3],
  pole: Record<string, string> = {},
) {
  const form = await p.get('/sprava/deska/novy');
  const r = await postSoubory(
    p,
    '/sprava/deska/novy',
    {
      _csrf: csrfZ(form.text),
      nazev,
      kategorie_id: '1',
      od: datumPraha(new Date()),
      do_odvolani: 'ano',
      ...pole,
    },
    soubory,
  );
  const id = /\/sprava\/deska\/([0-9a-f-]{36})/.exec(r.url)?.[1];
  if (!id) throw new Error(`dokument nevznikl: ${r.res.status} ${r.url}`);
  const prilohy = await t.app.deska.prilohy(id);
  return { id, prilohy: prilohy.map((x) => x.id), stranka: r };
}

describe('příloha desky → text → hledání', () => {
  let dokumentId: string;
  let souborId: string;

  it('docx se při nahrání zařadí do fronty a worker z něj vyčte text', async () => {
    const docx = await docxSTextem([
      'Zápis ze zasedání zastupitelstva obce Testov',
      'Bod 3: Zastupitelstvo schválilo výstavbu kanalizace v části Dolní Testov.',
    ]);
    const v = await vyvesit('Zápis ze zasedání 9/2026', [
      { pole: 'prilohy', nazev: 'zápis.docx', data: docx, typ: DOCX },
    ]);
    dokumentId = v.id;
    souborId = v.prilohy[0]!;
    expect(await radek(souborId)).toMatchObject({ stav: 'ceka', pokusu: 0 });
    // štítek „OCR čeká“ v seznamu i v detailu
    expect((await p.get('/sprava/deska')).text).toContain('OCR čeká');
    expect(await fronta().zpracujVse()).toBe(1);
    const r = await radek(souborId);
    expect(r).toMatchObject({ stav: 'hotovo', zdroj: 'docx', pokusu: 1 });
    expect(r!.text).toContain('výstavbu kanalizace');
    expect(r!.trvani_ms).toBeGreaterThanOrEqual(0);
    expect((await p.get(`/sprava/deska/${dokumentId}`)).text).toContain('text ✓');
  });

  it('/hledat najde slovo z textu, odkáže na dokument desky a zvýrazní úryvek', async () => {
    const r = await verejne().get('/hledat?q=kanalizace');
    expect(r.text).toContain(`href="/uredni-deska/${dokumentId}"`);
    expect(r.text).toContain('<mark>kanalizace</mark>');
    expect(r.text).toContain('Prohledáváme i obsah dokumentů');
    expect(r.text).toContain('Úřední deska');
  });

  it('dokument nalezený podle názvu i podle textu je ve výsledcích jen jednou (s úryvkem)', async () => {
    const r = await verejne().get('/hledat?q=zasedani');
    const vyskytu = r.text.split(`href="/uredni-deska/${dokumentId}"`).length - 1;
    expect(vyskytu).toBe(1);
    expect(r.text).toContain('<mark>zasedání</mark>');
  });

  it('neveřejná příloha (dokument připravený na později, nebo v koši) se nehledá', async () => {
    const zitra = datumPraha(new Date(Date.now() + 2 * 86_400_000));
    const v = await vyvesit(
      'Připravené oznámení',
      [
        {
          pole: 'prilohy',
          nazev: 'tajne.docx',
          data: await docxSTextem(['Heslo zasedání je kolotočář.']),
          typ: DOCX,
        },
      ],
      { od: zitra },
    );
    await fronta().zpracujVse();
    expect(await radek(v.prilohy[0]!)).toMatchObject({ stav: 'hotovo' });
    const r = await verejne().get('/hledat?q=kolotocar');
    expect(r.text).not.toContain('kolotočář');
    expect(r.text).toContain('Nalezeno výsledků: 0');
    // v koši také ne
    await t.app.deska
      .doKose(dokumentId, true, 'x'.repeat(36).replace(/x/g, '0'), null)
      .catch(() => undefined);
  });
});

describe('soubor ke stažení a jiné soubory', () => {
  it('dokument ke stažení → odkaz na /dokumenty#d-<id> a štítek ve správě', async () => {
    const form = await p.get('/sprava/web/dokumenty');
    await postSoubory(
      p,
      '/sprava/web/dokumenty',
      { _csrf: csrfZ(form.text), nazev: 'Žádost o kácení', skupina: 'Formuláře' },
      [
        {
          pole: 'soubor',
          nazev: 'kaceni.docx',
          data: await docxSTextem(['Žádost o povolení kácení dřevin rostoucích mimo les.']),
          typ: DOCX,
        },
      ],
    );
    expect((await p.get('/sprava/web/dokumenty')).text).toContain('OCR čeká');
    await fronta().zpracujVse();
    expect((await p.get('/sprava/web/dokumenty')).text).toContain('text ✓');
    const d = (await t.app.web.dokumenty.seznam()).find((x) => x.nazev === 'Žádost o kácení')!;
    const r = await verejne().get('/hledat?q=dreviny');
    expect(r.text).toContain(`href="/dokumenty#d-${d.id}"`);
    expect(r.text).toContain('<mark>dřevin</mark>');
    // sloučení s výsledkem podle názvu: jen jeden odkaz na tento dokument
    const r2 = await verejne().get('/hledat?q=kaceni');
    expect(r2.text.split('Žádost o kácení').length - 1).toBe(1);
    expect((await verejne().get('/dokumenty')).text).toContain(`id="d-${d.id}"`);
  });

  it('fotka galerie se do fronty nezařazuje, obrázek jako příloha desky ano', async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const foto = await t.app.soubory.uloz({ data: png, nazev: 'foto.png', druh: 'obrazek' });
    if ('chyba' in foto) throw new Error(foto.chyba);
    expect(await radek(foto.soubor.id)).toBeUndefined();
    const sken = await t.app.soubory.uloz({ data: png, nazev: 'sken.png', druh: 'dokument' });
    if ('chyba' in sken) throw new Error(sken.chyba);
    expect(sken.soubor.druh).toBe('obrazek');
    expect(await radek(sken.soubor.id)).toMatchObject({ stav: 'ceka' });
    await fronta().zpracujVse();
    // bez tesseractu nepodporováno, s ním prázdný obrázek = bez textu
    expect(['nepodporovano', 'bez_textu']).toContain((await radek(sken.soubor.id))!.stav);
  });

  it('soubor, který na webu nikde není, se ve výsledcích neukáže', async () => {
    const v = await t.app.soubory.uloz({
      data: await docxSTextem(['Osiřelý dokument se slovem velbloudice.']),
      nazev: 'osirely.docx',
      druh: 'dokument',
    });
    if ('chyba' in v) throw new Error(v.chyba);
    await fronta().zpracujVse();
    expect(await radek(v.soubor.id)).toMatchObject({ stav: 'hotovo' });
    expect((await verejne().get('/hledat?q=velbloudice')).text).toContain('Nalezeno výsledků: 0');
  });

  it('stránka webu s odkazem na soubor → výsledek vede na stránku', async () => {
    const v = await t.app.soubory.uloz({
      data: await docxSTextem(['Pravidla pro pronájem sálu: kauce činí dva tisíce korun.']),
      nazev: 'pravidla.docx',
      druh: 'dokument',
    });
    if ('chyba' in v) throw new Error(v.chyba);
    await fronta().zpracujVse();
    const { PRAZDNA_POLE } = await import('../src/moduly/web/obsah.js');
    await t.app.web.obsah.uloz(
      null,
      'stranka',
      {
        ...PRAZDNA_POLE,
        titulek: 'Pronájem sálu',
        obsah_html: `<p>Soubor: <a href="/soubory/${v.soubor.id}/pravidla.docx">pravidla</a></p>`,
      },
      'zverejnit',
      null,
    );
    const r = await verejne().get('/hledat?q=kauce');
    expect(r.text).toContain('href="/pronajem-salu"');
    expect(r.text).toContain('v příloze pravidla.docx');
  });
});

describe('správa fronty', () => {
  it('stránka ukazuje stav fronty, počty podle stavu a seznamy', async () => {
    const r = await p.get('/sprava/web/text-dokumentu');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('Ve frontě čeká: 0');
    expect(r.text).toContain('Dnes zpracováno:');
    expect(r.text).toContain('Zkontrolovat všechny dokumenty znovu');
    expect(r.text).toContain('Znovu jen chyby a bez textu');
    expect(r.text).toMatch(/s textem<\/strong>|s textem <strong>/);
  });

  it('„Zpracovat znovu“ vrátí soubor do fronty, „Zpracovat teď“ přednostně; obojí auditované', async () => {
    const d = (await t.app.web.dokumenty.seznam()).find((x) => x.nazev === 'Žádost o kácení')!;
    const stranka = await p.get('/sprava/web/text-dokumentu');
    await p.post('/sprava/web/text-dokumentu', {
      _csrf: csrfZ(stranka.text),
      akce: 'znovu',
      id: d.soubor_id,
    });
    expect(await radek(d.soubor_id)).toMatchObject({ stav: 'ceka', pokusu: 0, priorita: 0 });
    const r = await p.get('/sprava/web/text-dokumentu');
    expect(r.text).toContain('Ve frontě čeká: 1');
    expect(r.text).toContain('kaceni.docx');
    await p.post('/sprava/web/text-dokumentu', { _csrf: csrfZ(r.text), akce: 'ted', id: d.soubor_id });
    expect(await radek(d.soubor_id)).toMatchObject({ stav: 'ceka', priorita: 1 });
    expect((await p.get('/sprava/web/text-dokumentu')).text).toContain('přednostně');
    // dashboard: karta s frontou
    expect((await p.get('/sprava')).text).toContain('Text dokumentů: ve frontě 1');
    await fronta().zpracujVse();
    expect(await radek(d.soubor_id)).toMatchObject({ stav: 'hotovo', priorita: 0 });
    const audit = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', 'in', ['text.zpracovat_znovu', 'text.zpracovat_ted'])
      .execute();
    expect(audit.map((a) => a.akce).sort()).toEqual(['text.zpracovat_ted', 'text.zpracovat_znovu']);
    expect((await p.get('/sprava/web/text-dokumentu')).text).toMatch(/Dnes zpracováno: [1-9]/);
  });

  it('hromadně: bez potvrzení nic, s potvrzením zařadí všechny / jen chyby a bez textu', async () => {
    const stranka = await p.get('/sprava/web/text-dokumentu');
    const bez = await p.post('/sprava/web/text-dokumentu', { _csrf: csrfZ(stranka.text), akce: 'vse' });
    expect(bez.text).toContain('potřeba potvrdit');
    expect(await fronta().pocetKZarazeni('vse')).toBeGreaterThanOrEqual(5);
    const vse = await p.post('/sprava/web/text-dokumentu', {
      _csrf: csrfZ(stranka.text),
      akce: 'vse',
      potvrdit: 'ano',
    });
    expect(vse.text).toMatch(/Do fronty zařazeno dokumentů: [5-9]|Do fronty zařazeno dokumentů: \d{2,}/);
    const ceka = await t.db
      .selectFrom('soubory_text')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('stav', '=', 'ceka')
      .executeTakeFirstOrThrow();
    expect(Number(ceka.n)).toBe(await fronta().pocetKZarazeni('vse'));
    await fronta().zpracujVse();
    const chyby = await fronta().pocetKZarazeni('znovu-chyby');
    const jen = await p.post('/sprava/web/text-dokumentu', {
      _csrf: csrfZ(stranka.text),
      akce: 'znovu-chyby',
      potvrdit: 'ano',
    });
    expect(jen.text).toContain(`Do fronty zařazeno dokumentů: ${chyby}`);
    await fronta().zpracujVse();
    const audit = await t.db
      .selectFrom('audit_log')
      .select(['akce', 'detail'])
      .where('akce', 'in', ['text.znovu_vse', 'text.znovu_chyby'])
      .execute();
    expect(audit.map((a) => a.akce).sort()).toEqual(['text.znovu_chyby', 'text.znovu_vse']);
  });

  it('role: občan 403, samotná role deska stačí', async () => {
    const obcan = await prihlasSRoli(t, '+420777600002', []);
    expect((await obcan.get('/sprava/web/text-dokumentu')).res.status).toBe(403);
    const deska = await prihlasSRoli(t, '+420777600003', ['deska']);
    expect((await deska.get('/sprava/web/text-dokumentu')).res.status).toBe(200);
  });

  it('skript (--chybejici) zařadí soubory bez řádku a nic hotového nepřepíše', async () => {
    const d = (await t.app.web.dokumenty.seznam()).find((x) => x.nazev === 'Žádost o kácení')!;
    await t.db.deleteFrom('soubory_text').where('soubor_id', '=', d.soubor_id).execute();
    expect(await fronta().pocetKZarazeni('chybejici')).toBe(1);
    expect(await fronta().zaradHromadne('chybejici')).toBe(1);
    expect(await fronta().zaradHromadne('chybejici')).toBe(0);
    expect(await radek(d.soubor_id)).toMatchObject({ stav: 'ceka' });
    await fronta().zpracujVse();
  });
});

describe('odolnost', () => {
  it('chyba se opakuje s odkladem, po 3 pokusech zůstává jako chyba; „Zpracovat znovu“ ji resetuje', async () => {
    const v = await t.app.soubory.uloz({
      data: await docxSTextem(['Dokument, který zmizí z disku.']),
      nazev: 'zmizi.docx',
      druh: 'dokument',
    });
    if ('chyba' in v) throw new Error(v.chyba);
    await fs.rm(t.app.soubory.cesta(v.soubor.id));
    await fronta().zpracujVse();
    let r = await radek(v.soubor.id);
    expect(r).toMatchObject({ stav: 'ceka', pokusu: 1 });
    expect(r!.dalsi_pokus_at!.getTime()).toBeGreaterThan(Date.now());
    expect(r!.chyba).toContain('ENOENT');
    // odklad platí: worker ho teď nevezme
    expect(await fronta().zpracujVse()).toBe(0);
    for (let i = 0; i < 2; i++) {
      await t.db
        .updateTable('soubory_text')
        .set({ dalsi_pokus_at: null })
        .where('soubor_id', '=', v.soubor.id)
        .execute();
      await fronta().zpracujVse();
    }
    r = await radek(v.soubor.id);
    expect(r).toMatchObject({ stav: 'chyba', pokusu: 3, dalsi_pokus_at: null });
    expect((await p.get('/sprava/web/text-dokumentu')).text).toContain('pokusů: 3');
    await fronta().zarad([v.soubor.id]);
    expect(await radek(v.soubor.id)).toMatchObject({ stav: 'ceka', pokusu: 0 });
    await t.db.deleteFrom('soubory_text').where('soubor_id', '=', v.soubor.id).execute();
  });

  it('zaseknuté zpracování (pád procesu) se vrátí do fronty', async () => {
    const v = await t.app.soubory.uloz({
      data: await docxSTextem(['Zaseknutý dokument, u kterého proces spadl uprostřed zpracování.']),
      nazev: 'zasek.docx',
      druh: 'dokument',
    });
    if ('chyba' in v) throw new Error(v.chyba);
    await sql`UPDATE soubory_text SET stav = 'zpracovava', zacatek_at = now() - interval '2 hours', pokusu = 1
               WHERE soubor_id = ${v.soubor.id}`.execute(t.db);
    expect(await fronta().uklidZaseknute()).toBe(1);
    expect(await radek(v.soubor.id)).toMatchObject({ stav: 'ceka', chyba: 'zpracování bylo přerušeno' });
    await fronta().zpracujVse();
    expect(await radek(v.soubor.id)).toMatchObject({ stav: 'hotovo' });
  });

  it('hromadné zařazení nesahá na soubor, který se právě zpracovává', async () => {
    const v = await t.app.soubory.uloz({
      data: await docxSTextem(['Právě zpracovávaný dokument, kterého se hromadné zařazení nesmí dotknout.']),
      nazev: 'bezi.docx',
      druh: 'dokument',
    });
    if ('chyba' in v) throw new Error(v.chyba);
    await sql`UPDATE soubory_text SET stav = 'zpracovava', zacatek_at = now() WHERE soubor_id = ${v.soubor.id}`.execute(
      t.db,
    );
    await fronta().zaradHromadne('vse');
    expect(await radek(v.soubor.id)).toMatchObject({ stav: 'zpracovava' });
    expect(await fronta().zarad([v.soubor.id])).toBe(0);
    await sql`UPDATE soubory_text SET stav = 'ceka' WHERE soubor_id = ${v.soubor.id}`.execute(t.db);
    await fronta().zpracujVse();
  });
});

describe('PDF při nahrání', () => {
  it('rychlá kontrola vrstvy dá správci hlášku', async () => {
    const v = await vyvesit('Vyhláška o poplatku ze psů', [
      {
        pole: 'prilohy',
        nazev: 'vyhlaska.pdf',
        data: await fs.readFile(path.join(FIXTURES, 'vrstva.pdf')),
        typ: 'application/pdf',
      },
    ]);
    expect(v.stranka.text).toContain(
      maPoppler ? 'vyhlaska.pdf: textová vrstva v pořádku' : 'vyhlaska.pdf: text PDF zkontrolujeme na pozadí',
    );
    await fronta().zpracujVse();
    const r = await radek(v.prilohy[0]!);
    if (maPoppler) {
      expect(r).toMatchObject({ stav: 'hotovo', zdroj: 'vrstva', ma_vrstvu: true, stran: 1 });
      expect((await verejne().get('/hledat?q=poplatku%20ze%20psu')).text).toContain(`/uredni-deska/${v.id}`);
    } else {
      expect(r).toMatchObject({ stav: 'nepodporovano' });
      expect(r!.chyba).toContain('pdfinfo');
      expect((await p.get('/sprava/web/text-dokumentu')).text).toContain('chybí program pdfinfo');
    }
  });

  it.skipIf(!maOcr)(
    'sken bez vrstvy: hláška o OCR, text přes OCR, hledání ho najde',
    async () => {
      const v = await vyvesit('Oznámení o přerušení dodávky vody', [
        {
          pole: 'prilohy',
          nazev: 'sken.pdf',
          data: await fs.readFile(path.join(FIXTURES, 'sken.pdf')),
          typ: 'application/pdf',
        },
      ]);
      expect(v.stranka.text).toContain('sken.pdf: PDF nemá textovou vrstvu');
      expect(await radek(v.prilohy[0]!)).toMatchObject({ stav: 'ceka' });
      await fronta().zpracujVse();
      expect(await radek(v.prilohy[0]!)).toMatchObject({ stav: 'hotovo', zdroj: 'ocr', ma_vrstvu: false });
      const r = await verejne().get('/hledat?q=vodovod%20odstaven');
      expect(r.text).toContain(`href="/uredni-deska/${v.id}"`);
      expect(r.text).toContain('<mark>Vodovod</mark>');
      expect((await p.get('/sprava/deska')).text).toContain('text ✓ (OCR)');
    },
    180_000,
  );
});
