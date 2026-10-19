// Úřední deska: lhůty, přílohy (kontrola obsahu, EXIF), archiv, RSS, rozpočet, rozeslání, povinné informace, role.
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { casPraha, datumPraha, pridejDny, rozdilDni } from '../src/lib/datum.js';
import { coNahrazuje, zkontrolujDobu } from '../src/moduly/deska/sluzba.js';
import {
  csrfZ,
  MALE_PDF,
  postSoubory,
  prihlasSRoli,
  prihlasTelefonem,
  Prohlizec,
  spustTestApp,
  type TestApp,
} from './pomocnici.js';

describe('pravidla (bez DB)', () => {
  it('minimální doba vyvěšení počítá kalendářní dny', () => {
    expect(zkontrolujDobu({ min_dni: 15 }, '2026-10-01', '2026-10-16')).toEqual({ ok: true });
    expect(zkontrolujDobu({ min_dni: 15 }, '2026-10-01', '2026-10-15')).toEqual({
      chyba: 'kratke',
      minDo: '2026-10-16',
    });
    expect(zkontrolujDobu({ min_dni: 15 }, '2026-10-01', null)).toEqual({ ok: true });
    expect(zkontrolujDobu({ min_dni: 0 }, '2026-10-05', '2026-10-01')).toEqual({ chyba: 'do_pred_od' });
    expect(zkontrolujDobu({ min_dni: 0 }, 'blbost', null)).toEqual({ chyba: 'od_neplatne' });
  });
  it('schválený rozpočet nahrazuje návrh téhož roku, starší rozpočet i jeho rozpočtová opatření', () => {
    expect(coNahrazuje('rozpocet')).toEqual([
      { typ: 'navrh_rozpoctu', rok: 'nejvyse_stejny' },
      { typ: 'rozpocet', rok: 'starsi' },
      { typ: 'rozpoctove_opatreni', rok: 'starsi' },
    ]);
    expect(coNahrazuje('rozpoctove_opatreni')).toEqual([]);
  });
  it('pražský čas včetně přechodu na zimní čas', () => {
    expect(casPraha('2026-07-01')!.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(casPraha('2026-12-01')!.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(casPraha('2026-10-25', 23, 59, 59)!.toISOString()).toBe('2026-10-25T22:59:59.000Z');
    expect(rozdilDni('2026-10-20', '2026-11-04')).toBe(15);
    expect(pridejDny('2026-12-31', 1)).toBe('2027-01-01');
  });
});

let t: TestApp;
let redaktor: Prohlizec;
let spravce: Prohlizec;
beforeAll(async () => {
  t = await spustTestApp();
  redaktor = await prihlasSRoli(t, '777400001', ['deska']);
  spravce = await prihlasSRoli(t, '777400002', ['spravce']);
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const dnes = () => datumPraha(new Date());
async function katId(slug: string) {
  return String(
    (await t.db.selectFrom('ud_kategorie').select('id').where('slug', '=', slug).executeTakeFirstOrThrow())
      .id,
  );
}

async function vyvesit(
  p: Prohlizec,
  pole: Record<string, string>,
  soubory: Parameters<typeof postSoubory>[3] = [],
) {
  const form = await p.get('/sprava/deska/novy');
  const r = await postSoubory(p, '/sprava/deska/novy', { _csrf: csrfZ(form.text), ...pole }, soubory);
  return potvrdNahrazeni(p, '/sprava/deska/novy', pole, r);
}

// rozpočtový dokument, který by sejmul starší: potvrdit druhý krok formuláře (jako uživatel)
async function potvrdNahrazeni(
  p: Prohlizec,
  url: string,
  pole: Record<string, string>,
  r: Awaited<ReturnType<typeof postSoubory>>,
) {
  const m = /name="nahrazeni_potvrzeno" value="([^"]+)"/.exec(r.text);
  if (!m) return r;
  const ulozene = [...r.text.matchAll(/name="prilohy_ulozene" value="([^"]+)"/g)].map((x) => x[1]!);
  return postSoubory(
    p,
    url,
    {
      _csrf: csrfZ(r.text),
      ...pole,
      potvrdit_nahrazeni: 'ano',
      nahrazeni_potvrzeno: m[1]!,
      ...(ulozene.length ? { prilohy_ulozene: ulozene } : {}),
    },
    [],
  );
}

describe('vyvěšení', () => {
  it('redaktor vyvěsí dokument s PDF; je na desce, v RSS a příloha se stáhne s Content-Disposition', async () => {
    const r = await vyvesit(
      redaktor,
      {
        nazev: 'Záměr pronájmu pozemku p. č. 123',
        kategorie_id: await katId('zamery'),
        popis: 'Pronájem louky.',
        od: dnes(),
      },
      [{ pole: 'prilohy', nazev: 'záměr pronájmu.pdf', data: MALE_PDF, typ: 'application/pdf' }],
    );
    expect(r.text).toContain('visí na úřední desce');
    const d = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', 'like', 'Záměr pronájmu%')
      .executeTakeFirstOrThrow();
    // výchozí lhůta kategorie: 15 dní
    expect(rozdilDni(datumPraha(d.vyveseno_od), datumPraha(d.sejmuto_do!))).toBe(15);
    const verejne = await new Prohlizec(t.base).get('/uredni-deska');
    expect(verejne.text).toContain('Záměr pronájmu pozemku p. č. 123');
    const detail = await new Prohlizec(t.base).get(`/uredni-deska/${d.id}`);
    const odkaz = /href="(\/soubory\/[^"]+)"/.exec(detail.text)![1]!;
    const soubor = await fetch(t.base + odkaz.replace(/&amp;/g, '&'));
    expect(soubor.status).toBe(200);
    expect(soubor.headers.get('content-type')).toBe('application/pdf');
    expect(soubor.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''z%C3%A1m%C4%9Br%20pron%C3%A1jmu.pdf",
    );
    expect(soubor.headers.get('x-content-type-options')).toBe('nosniff');
    const rss = await fetch(`${t.base}/uredni-deska/rss.xml`);
    expect(rss.headers.get('content-type')).toContain('application/rss+xml');
    expect(await rss.text()).toContain('Záměr pronájmu pozemku p. č. 123');
    const hledani = await new Prohlizec(t.base).get('/uredni-deska?q=zamer%20louk');
    expect(hledani.text).toContain('Záměr pronájmu');
    const nic = await new Prohlizec(t.base).get('/uredni-deska?q=autobus');
    expect(nic.text).not.toContain('Záměr pronájmu');
  });

  it('vyhlášku nejde vyvěsit na kratší dobu než 15 dní', async () => {
    const r = await vyvesit(redaktor, {
      nazev: 'Vyhláška o psech',
      kategorie_id: await katId('vyhlasky'),
      od: dnes(),
      do: pridejDny(dnes(), 10),
    });
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('nejméně 15 dní');
    expect(r.text).toContain('Vyhláška o psech'); // formulář se vrátil vyplněný
    expect(
      await t.db
        .selectFrom('ud_dokumenty')
        .select('id')
        .where('nazev', '=', 'Vyhláška o psech')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('soubor podle přípony PDF, ale ve skutečnosti spustitelný, se odmítne', async () => {
    const r = await vyvesit(redaktor, { nazev: 'Podvrh', kategorie_id: await katId('ostatni'), od: dnes() }, [
      {
        pole: 'prilohy',
        nazev: 'faktura.pdf',
        data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00binarka'),
        typ: 'application/pdf',
      },
    ]);
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('Tento typ souboru nejde nahrát');
  });

  it('obrázek se přeuloží bez EXIF/GPS', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#88aa44' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'TajnyFotak', Copyright: 'GPS 50.61 15.05' } })
      .toBuffer();
    expect(jpeg.includes(Buffer.from('TajnyFotak'))).toBe(true);
    await vyvesit(redaktor, { nazev: 'Mapa uzavírky', kategorie_id: await katId('ostatni'), od: dnes() }, [
      { pole: 'prilohy', nazev: 'mapa.jpg', data: jpeg, typ: 'image/jpeg' },
    ]);
    const s = await t.db
      .selectFrom('soubory')
      .selectAll()
      .where('puvodni_nazev', '=', 'mapa.jpg')
      .executeTakeFirstOrThrow();
    const res = await fetch(`${t.base}/soubory/${s.id}/mapa.jpg`);
    const data = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(data.includes(Buffer.from('TajnyFotak'))).toBe(false);
    const nahled = await fetch(`${t.base}/soubory/${s.id}/mapa.jpg?v=nahled`);
    expect(nahled.headers.get('content-type')).toBe('image/webp');
  });

  it('dokument vyvěšený dopředu není veřejně vidět; sejmutý je v archivu', async () => {
    const za3 = pridejDny(dnes(), 3);
    await vyvesit(redaktor, { nazev: 'Budoucí oznámení', kategorie_id: await katId('ostatni'), od: za3 });
    const budouci = await t.db
      .selectFrom('ud_dokumenty')
      .select('id')
      .where('nazev', '=', 'Budoucí oznámení')
      .executeTakeFirstOrThrow();
    expect((await new Prohlizec(t.base).get('/uredni-deska')).text).not.toContain('Budoucí oznámení');
    expect((await new Prohlizec(t.base).get(`/uredni-deska/${budouci.id}`)).res.status).toBe(404);
    const sprava = await redaktor.get('/sprava/deska?stav=pripraveno');
    expect(sprava.text).toContain('Budoucí oznámení');

    const kat = await t.db
      .selectFrom('ud_kategorie')
      .select('id')
      .where('slug', '=', 'zastupitelstvo')
      .executeTakeFirstOrThrow();
    await t.app.deska.uloz(
      null,
      {
        nazev: 'Usnesení ze zasedání 2025',
        kategorieId: kat.id,
        cisloJednaci: '',
        puvodce: '',
        popis: '',
        od: '2025-03-01',
        do: '2025-03-20',
        typRozpoctu: null,
        rok: null,
      },
      null,
    );
    expect((await new Prohlizec(t.base).get('/uredni-deska')).text).not.toContain(
      'Usnesení ze zasedání 2025',
    );
    const archiv = await new Prohlizec(t.base).get('/uredni-deska/archiv?rok=2025');
    expect(archiv.text).toContain('Usnesení ze zasedání 2025');
  });
});

describe('rozpočet', () => {
  it('schválený rozpočet sejme návrh téhož roku; /rozpocet ukazuje platné', async () => {
    const kat = await katId('rozpocet');
    await vyvesit(spravce, {
      nazev: 'Návrh rozpočtu 2027',
      kategorie_id: kat,
      od: pridejDny(dnes(), -20),
      duvod_data: 'visel na papírové desce',
      do_odvolani: 'ano',
      typ_rozpoctu: 'navrh_rozpoctu',
      rok: '2027',
    });
    let rozpocet = await new Prohlizec(t.base).get('/rozpocet');
    expect(rozpocet.text).toContain('Návrh rozpočtu 2027');
    await vyvesit(spravce, {
      nazev: 'Rozpočet 2027',
      kategorie_id: kat,
      od: dnes(),
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2027',
    });
    const navrh = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Návrh rozpočtu 2027')
      .executeTakeFirstOrThrow();
    expect(navrh.sejmuto_do).not.toBeNull();
    expect(navrh.sejmuti_duvod).toContain('Rozpočet 2027');
    rozpocet = await new Prohlizec(t.base).get('/rozpocet');
    expect(rozpocet.text).toContain('Schválený rozpočet');
    expect(rozpocet.text).toMatch(/Starší rozpočtové dokumenty \(1\)/);
  });
});

describe('rozeslání a práva', () => {
  it('„vyvěsit + rozeslat“ založí hlášení infokanálu s odkazem', async () => {
    await t.app.infokanal.zalozNeboObnov({
      jmeno: 'Odběratel',
      telefon: '+420777400100',
      email: 'odber@example.cz',
      castObce: '',
      kanal: 'smisene',
      optouty: [],
      zdroj: 'urad',
      overeno: true,
      souhlas: true,
    });
    const r = await vyvesit(redaktor, {
      nazev: 'Veřejná vyhláška — oprava silnice',
      kategorie_id: await katId('verejne-vyhlasky'),
      od: dnes(),
      rozeslat: 'ano',
    });
    expect(r.text).toContain('Zprávu dostane 1 odběratelů');
    const d = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', 'like', 'Veřejná vyhláška%')
      .executeTakeFirstOrThrow();
    const h = await t.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .where('id', '=', d.hlaseni_id!)
      .executeTakeFirstOrThrow();
    expect(h.email_text).toContain(`/uredni-deska/${d.id}`);
    expect(h.sms_text).toBeNull(); // SMS jen na vyžádání
  });

  it('občan do správy nesmí; redaktor nesmí předčasně sejmout ani do koše; správce ano a jde obnovit', async () => {
    const obcan = new Prohlizec(t.base);
    await prihlasTelefonem(obcan, '777400099');
    expect((await obcan.get('/sprava/deska')).res.status).toBe(403);
    const d = await t.db
      .selectFrom('ud_dokumenty')
      .selectAll()
      .where('nazev', '=', 'Mapa uzavírky')
      .executeTakeFirstOrThrow();
    const form = await redaktor.get(`/sprava/deska/${d.id}`);
    const zakaz = await redaktor.post(
      `/sprava/deska/${d.id}/sejmout`,
      { _csrf: csrfZ(form.text), duvod: 'test' },
      false,
    );
    expect(zakaz.res.status).toBe(403);
    const sf = await spravce.get(`/sprava/deska/${d.id}`);
    await spravce.post(`/sprava/deska/${d.id}/kos`, { _csrf: csrfZ(sf.text), akce: 'smazat' });
    expect((await new Prohlizec(t.base).get(`/uredni-deska/${d.id}`)).res.status).toBe(404);
    const sf2 = await spravce.get(`/sprava/deska/${d.id}`);
    await spravce.post(`/sprava/deska/${d.id}/kos`, { _csrf: csrfZ(sf2.text), akce: 'obnovit' });
    expect((await new Prohlizec(t.base).get(`/uredni-deska/${d.id}`)).res.status).toBe(200);
    const sf3 = await spravce.get(`/sprava/deska/${d.id}`);
    const bezDuvodu = await spravce.post(`/sprava/deska/${d.id}/sejmout`, {
      _csrf: csrfZ(sf3.text),
      duvod: '',
    });
    expect(bezDuvodu.text).toContain('Napište důvod');
    await spravce.post(`/sprava/deska/${d.id}/sejmout`, {
      _csrf: csrfZ(bezDuvodu.text),
      duvod: 'vyvěšeno omylem',
    });
    const po = await new Prohlizec(t.base).get(`/uredni-deska/${d.id}`);
    expect(po.text).toContain('byl z úřední desky sejmut');
    expect(po.text).toContain('vyvěšeno omylem');
  });
});

describe('povinně zveřejňované informace', () => {
  it('14 bodů z profilu obce, chybějící zvýrazněné, úprava se sanitizuje', async () => {
    const verejne = await new Prohlizec(t.base).get('/povinne-informace');
    expect(verejne.text).toContain('14. Výroční zpráva');
    expect(verejne.text).toContain('Obec Testov');
    const prehled = await spravce.get('/sprava/povinne-informace');
    expect(prehled.text).toMatch(/Chybí doplnit bodů: \d+/);
    const bod = await spravce.get('/sprava/povinne-informace/12.1');
    await spravce.post('/sprava/povinne-informace/12.1', {
      _csrf: csrfZ(bod.text),
      obsah: '<p onclick="zlo()">Kopie A4: 2 Kč</p><script>alert(1)</script>',
      akce: 'ulozit',
    });
    const po = await new Prohlizec(t.base).get('/povinne-informace');
    expect(po.text).toContain('<p>Kopie A4: 2 Kč</p>');
    expect(po.text).not.toContain('alert(1)');
    expect(po.text).not.toContain('onclick');
    expect((await redaktor.get('/sprava/povinne-informace')).res.status).toBe(403);
  });
});
