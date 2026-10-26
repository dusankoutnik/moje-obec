// Propojení akcí webu s rezervacemi (docs/AKCE-PROPOJENI.md): koncepty ze synchronizace, idempotence, série,
// návrh propojení místo duplicity, „jen v kalendáři“, propojení v editoru, skrytí propojeného termínu v kalendáři,
// pozvánky v Aktualitách, změna a zrušení termínu, rozesílka z příspěvku, klikací statistiky úvodu.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { podpisTerminu, prevedPolozky } from '../src/moduly/web/akce-externi.js';
import { jeShoda, podobneNazvy } from '../src/moduly/web/akce-propojeni.js';
import { obecZObjektu } from '../src/config/obec.js';
import { datumPraha } from '../src/lib/datum.js';
import {
  csrfZ,
  postSoubory,
  prihlasSRoli,
  Prohlizec,
  spustTestApp,
  testovaciObec,
  type TestApp,
} from './pomocnici.js';

/** den za n dní (pražský kalendář) */
const den = (n: number) => datumPraha(new Date(Date.now() + n * 86_400_000));

interface P {
  id: string;
  typ: string;
  serie: string | null;
  zdroj_nazev: string;
  datum: string;
  od: string | null;
  do: string | null;
  cely_den: boolean;
  nazev: string;
  popis?: string;
  odkaz?: string | null;
}
const pol = (o: Partial<P> & Pick<P, 'id' | 'nazev' | 'datum'>): P => ({
  typ: 'rezervace',
  serie: null,
  zdroj_nazev: 'Sál Kulturního domu',
  od: '19:00',
  do: '21:00',
  cely_den: false,
  ...o,
});

describe('podobnost názvů a shoda termínů', () => {
  it('názvy bez diakritiky, společné slovo nebo obsažení', () => {
    expect(podobneNazvy('Turnaj v nohejbale', 'Nohejbalový TURNAJ')).toBe(true);
    expect(podobneNazvy('Koncert Clapton & Dylan', 'CLAPTON')).toBe(true);
    expect(podobneNazvy('Koncert', 'Turnaj')).toBe(false);
    expect(podobneNazvy('Bál', 'Bál')).toBe(false); // krátká slova (pod 4 znaky) se nepočítají
  });
  it('shoda = stejný den a podobný název nebo překryv času', () => {
    const [e] = prevedPolozky([pol({ id: 'r1', nazev: 'Divadlo', datum: den(5) })]);
    const zacatek = e!.datum;
    const akce = (titulek: string, posun = 0) => ({
      id: 'x',
      titulek,
      datum: new Date(zacatek.getTime() + posun),
      akce_konec: null,
      akce_cely_den: false,
    });
    expect(jeShoda(akce('Ochotnické divadlo'), e!)).toBe(true);
    expect(jeShoda(akce('Úplně jiná věc', 30 * 60_000), e!)).toBe(true); // čas se překrývá
    expect(jeShoda(akce('Úplně jiná věc', 5 * 3600_000), e!)).toBe(false);
    expect(jeShoda(akce('Divadlo', 86_400_000), e!)).toBe(false); // jiný den
  });
  it('podpis série nezávisí na nejbližším výskytu, jen na dni v týdnu a čase', () => {
    const a = prevedPolozky([pol({ id: 'r1', serie: 's9', nazev: 'Jóga', datum: den(7) })])[0]!;
    const b = prevedPolozky([pol({ id: 'r2', serie: 's9', nazev: 'Jóga', datum: den(14) })])[0]!;
    expect(podpisTerminu(a)).toBe(podpisTerminu(b));
    expect(podpisTerminu({ ...a, od: '18:00' })).not.toBe(podpisTerminu(a));
  });
  it('fakta v obec.yml: odkaz jen cesta na webu nebo https', () => {
    const zaklad = { obec: { nazev: 'O', kratky_nazev: 'O', casti: ['O'] } };
    const s = (odkaz: string) => () =>
      obecZObjektu({ ...zaklad, obec: { ...zaklad.obec, fakta: [{ hodnota: '1', popisek: 'x', odkaz }] } });
    expect(s('/ucet')).not.toThrow();
    expect(s('https://example.cz/a')).not.toThrow();
    expect(s('//zlo.example')).toThrow();
    expect(s('javascript:alert(1)')).toThrow();
    expect(s('http://example.cz')).toThrow();
    expect(obecZObjektu(zaklad).web).toEqual({
      akce_koncepty: true,
      stat_zpravy_kategorie: '',
      rubrika_knihovny: 'knihovna',
      rychle_odkazy: [],
    });
    const dlazdice = (odkaz: string) => () =>
      obecZObjektu({ ...zaklad, web: { rychle_odkazy: [{ nazev: 'Knihovna', odkaz }] } });
    expect(dlazdice('/sluzby-obec/obecni-knihovna')).not.toThrow();
    expect(dlazdice('//zlo.example')).toThrow();
    expect(dlazdice('javascript:alert(1)')).toThrow();
  });
});

describe('synchronizace a správa akcí z rezervací', () => {
  let t: TestApp;
  let red: Prohlizec;
  let polozky: P[] = [];
  let dostupny = true;
  const vychoziFakta = testovaciObec.obec.fakta;

  beforeAll(async () => {
    t = await spustTestApp();
    t.app.web.kalendar.nacti = async (ted = new Date()) => ({
      dostupny,
      akce: prevedPolozky(polozky, ted),
    });
    red = await prihlasSRoli(t, '777 610 001', ['web', 'redaktor']);
  });
  afterAll(async () => {
    t.app.obec.obec.fakta = vychoziFakta;
    t.app.obec.web.stat_zpravy_kategorie = '';
    t.app.obec.web.akce_koncepty = true;
    await t.zavri();
  });

  const akceRef = (ref: string) =>
    t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('rezervace_ref', '=', ref)
      .where('smazano_at', 'is', null)
      .executeTakeFirst();

  async function ulozAkci(pole: Record<string, string>, url = '/sprava/web/novy?typ=akce') {
    const form = await red.get(url);
    const action = url.startsWith('/sprava/web/novy') ? '/sprava/web/novy' : url;
    return postSoubory(red, action, { _csrf: csrfZ(form.text), typ: 'akce', ...pole }, []);
  }

  it('veřejný termín → koncept (ne zveřejněný); opakovaná synchronizace nic nezdvojí; série = jeden koncept', async () => {
    polozky = [
      pol({ id: 'r10', nazev: 'Podzimní koncert', datum: den(10), popis: 'Hraje kapela' }),
      pol({ id: 'r20', serie: 's5', nazev: 'Jóga pro seniory', datum: den(3), od: '18:30', do: '19:30' }),
      pol({ id: 'r21', serie: 's5', nazev: 'Jóga pro seniory', datum: den(10), od: '18:30', do: '19:30' }),
    ];
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(2);
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(0);
    const k = await akceRef('r10');
    expect(k?.stav).toBe('koncept');
    expect(k?.zdroj).toBe('rezervace');
    expect(k?.akce_misto).toBe('Sál Kulturního domu');
    expect(k?.perex).toBe('Hraje kapela');
    const serie = await akceRef('s5');
    expect(serie?.perex).toMatch(/^každ/);
    expect(serie && datumPraha(serie.datum!)).toBe(den(3)); // nejbližší výskyt
    expect(await akceRef('r20')).toBeUndefined();
    // koncept na webu není, termín v kalendáři ano (jako dosud)
    const akce = await new Prohlizec(t.base).get('/akce');
    expect(akce.text).toContain('Podzimní koncert');
    expect(akce.text).not.toContain(`/akce/${k!.slug}"`);
    // správa: seznam ke zpracování a počet na dashboardu
    const z = await red.get('/sprava/web/akce/zpracovani');
    expect(z.text).toContain('Nové akce z rezervací (2)');
    expect((await red.get('/sprava/web')).text).toContain('Akcí ke zpracování: 2');
    expect((await red.get('/sprava')).text).toContain('Akcí ke zpracování: 2');
  });

  it('přejmenování v rezervacích → nedotčený koncept převezme nový název', async () => {
    polozky = polozky.map((p) => (p.id === 'r10' ? { ...p, nazev: 'Adventní koncert' } : p));
    await t.app.web.propojeni.synchronizuj();
    expect((await akceRef('r10'))?.titulek).toBe('Adventní koncert');
    expect((await red.get('/sprava/web/akce/zpracovani')).text).toContain('Adventní koncert');
    polozky = polozky.map((p) => (p.id === 'r10' ? { ...p, nazev: 'Podzimní koncert' } : p));
    await t.app.web.propojeni.synchronizuj();
    expect((await akceRef('r10'))?.titulek).toBe('Podzimní koncert');
  });

  it('nedostupné rezervace = žádné koncepty ani „zrušené“', async () => {
    dostupny = false;
    polozky = [...polozky, pol({ id: 'r99', nazev: 'Nedostupná', datum: den(4) })];
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(0);
    expect((await t.app.web.propojeni.prehled()).zrusene).toEqual([]);
    dostupny = true;
    polozky = polozky.filter((p) => p.id !== 'r99');
  });

  it('podobná akce na webu ve stejný den → návrh propojení místo duplicity; propojení schová termín z kalendáře', async () => {
    await ulozAkci({
      titulek: 'Turnaj v nohejbale',
      datum_od: den(12),
      cas_od: '10:00',
      misto: 'Hřiště',
      akce: 'zverejnit',
    });
    polozky.push(
      pol({
        id: 'r30',
        nazev: 'Nohejbalový turnaj',
        datum: den(12),
        od: '09:00',
        do: '16:00',
        zdroj_nazev: 'Hřiště',
      }),
    );
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(0);
    const p = await t.app.web.propojeni.prehled();
    const navrh = p.navrhy.find((n) => n.termin.ref === 'r30');
    expect(navrh?.kandidati.map((k) => k.titulek)).toEqual(['Turnaj v nohejbale']);
    const z = await red.get('/sprava/web/akce/zpracovani');
    expect(z.text).toContain('Propojit s: Turnaj v nohejbale');
    const r = await red.post('/sprava/web/akce/zpracovani/propojit', {
      _csrf: csrfZ(z.text),
      ref: 'r30',
      akce_id: navrh!.kandidati[0]!.id,
    });
    expect(r.text).toContain('Akce je propojená s rezervací.');
    const a = await akceRef('r30');
    expect(a?.titulek).toBe('Turnaj v nohejbale');
    const kal = await new Prohlizec(t.base).get('/akce');
    expect(kal.text).toContain(`href="/akce/${a!.slug}"`);
    expect(kal.text).not.toContain('Nohejbalový turnaj');
    expect(kal.text.match(/Turnaj v nohejbale/g)?.length).toBe(1);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', '=', 'web.akce_propojeni')
      .execute();
    expect(audit.length).toBe(1);
  });

  it('„jen v kalendáři“: koncept do koše, termín se znovu nezaloží; jde vrátit', async () => {
    const z = await red.get('/sprava/web/akce/zpracovani');
    await red.post('/sprava/web/akce/zpracovani/ignorovat', { _csrf: csrfZ(z.text), ref: 'r10' });
    expect(await akceRef('r10')).toBeUndefined();
    const vKosi = await t.db
      .selectFrom('web_obsah')
      .select(['smazano_at'])
      .where('titulek', '=', 'Podzimní koncert')
      .executeTakeFirstOrThrow();
    expect(vKosi.smazano_at).not.toBeNull();
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(0);
    const z2 = await red.get('/sprava/web/akce/zpracovani');
    expect(z2.text).toContain('Termíny jen v kalendáři (1)');
    // termín zůstává v kalendáři webu
    expect((await new Prohlizec(t.base).get('/akce')).text).toContain('Podzimní koncert');
  });

  it('editor: propojení s rezervací a pozvánka v Aktualitách (i RSS, kategorie)', async () => {
    polozky.push(
      pol({ id: 'e7', typ: 'predprodej', nazev: 'Silvestrovský bál', datum: den(20), od: '20:00', do: null }),
    );
    const form = await red.get('/sprava/web/novy?typ=akce');
    expect(form.text).toContain('name="rezervace_ref"');
    expect(form.text).toContain('value="e7"');
    expect(form.text).not.toContain('value="r30"'); // propojený termín se nenabízí
    const kultura = await t.db
      .selectFrom('web_kategorie')
      .select('id')
      .where('slug', '=', 'kultura')
      .executeTakeFirstOrThrow();
    await ulozAkci({
      titulek: 'Silvestr v kulturáku',
      perex: 'Přijďte se rozloučit s rokem.',
      datum_od: den(20),
      cas_od: '20:00',
      misto: 'Kulturní dům',
      rezervace_ref: 'e7',
      v_aktualitach: 'ano',
      kategorie_id: String(kultura.id),
      akce: 'zverejnit',
    });
    const a = await akceRef('e7');
    expect(a?.titulek).toBe('Silvestr v kulturáku');
    expect(a?.v_aktualitach).toBe(true);
    const akt = await new Prohlizec(t.base).get('/aktuality');
    expect(akt.text).toContain(`href="/akce/${a!.slug}"`);
    expect(akt.text).toContain('pozvánka na');
    expect((await new Prohlizec(t.base).get('/aktuality?kategorie=kultura')).text).toContain(
      'Silvestr v kulturáku',
    );
    expect((await new Prohlizec(t.base).get('/aktuality?kategorie=sport')).text).not.toContain(
      'Silvestr v kulturáku',
    );
    const rss = await new Prohlizec(t.base).get('/aktuality/rss.xml');
    expect(rss.text).toContain(`/akce/${a!.slug}</link>`);
    // akce bez zatržítka v Aktualitách není
    expect(akt.text).not.toContain('Turnaj v nohejbale');
    // kalendář: termín předprodeje zastoupený akcí webu
    expect((await new Prohlizec(t.base).get('/akce')).text).not.toContain('Silvestrovský bál');
    // zrušení propojení v editoru
    await ulozAkci(
      {
        titulek: 'Silvestr v kulturáku',
        datum_od: den(20),
        cas_od: '20:00',
        rezervace_ref: '',
        akce: 'zverejnit',
      },
      `/sprava/web/obsah/${a!.id}`,
    );
    expect(await akceRef('e7')).toBeUndefined();
    await ulozAkci(
      {
        titulek: 'Silvestr v kulturáku',
        datum_od: den(20),
        cas_od: '20:00',
        rezervace_ref: 'e7',
        v_aktualitach: 'ano',
        akce: 'zverejnit',
      },
      `/sprava/web/obsah/${a!.id}`,
    );
    expect((await akceRef('e7'))?.id).toBe(a!.id);
  });

  it('série propojená se zveřejněnou akcí: v kalendáři jednou, s nejbližším termínem a opakováním', async () => {
    const k = (await akceRef('s5'))!;
    await t.app.web.obsah.uloz(
      k.id,
      'akce',
      { ...(await import('../src/moduly/web/obsah.js')).poleZRadku(k), titulek: 'Jóga každý týden' },
      'zverejnit',
      null,
    );
    const kal = await new Prohlizec(t.base).get('/akce');
    expect(kal.text.match(/Jóga každý týden/g)?.length).toBe(1);
    expect(kal.text).not.toContain('Jóga pro seniory');
    expect(kal.text).toContain('každý');
    const slug = (await akceRef('s5'))!.slug;
    const detail = await new Prohlizec(t.base).get(`/akce/${slug}`);
    expect(detail.text).toContain('nejbližší');
  });

  it('změna termínu v rezervacích → ke zpracování; Převzít termín změní akci; zmizení = zrušená rezervace', async () => {
    const a = (await akceRef('r30'))!;
    polozky = polozky.map((p) => (p.id === 'r30' ? { ...p, datum: den(13), od: '11:00' } : p));
    const p1 = await t.app.web.propojeni.prehled();
    expect(p1.zmeny.map((z) => z.akce.id)).toEqual([a.id]);
    const z = await red.get('/sprava/web/akce/zpracovani');
    expect(z.text).toContain('Termín v rezervacích se změnil na');
    await red.post('/sprava/web/akce/zpracovani/termin', {
      _csrf: csrfZ(z.text),
      akce_id: a.id,
      volba: 'prevzit',
    });
    const po = (await akceRef('r30'))!;
    expect(datumPraha(po.datum!)).toBe(den(13));
    expect((await t.app.web.propojeni.prehled()).zmeny).toEqual([]);
    // „Ponechat“: další změna se jen vezme na vědomí
    polozky = polozky.map((p) => (p.id === 'r30' ? { ...p, od: '12:00' } : p));
    expect((await t.app.web.propojeni.prehled()).zmeny.length).toBe(1);
    await red.post('/sprava/web/akce/zpracovani/termin', {
      _csrf: csrfZ(z.text),
      akce_id: a.id,
      volba: 'ponechat',
    });
    expect((await t.app.web.propojeni.prehled()).zmeny).toEqual([]);
    expect(datumPraha((await akceRef('r30'))!.datum!)).toBe(den(13));
    // zrušená rezervace: akce na webu zůstává, správa to ukáže
    polozky = polozky.filter((p) => p.id !== 'r30');
    const p2 = await t.app.web.propojeni.prehled();
    expect(p2.zrusene.map((o) => o.id)).toEqual([a.id]);
    expect((await red.get('/sprava/web/akce/zpracovani')).text).toContain('Zrušené rezervace (1)');
    expect((await t.app.web.obsah.podleId(a.id))?.stav).toBe('zverejneno');
    await red.post('/sprava/web/akce/zpracovani/odpojit', { _csrf: csrfZ(z.text), akce_id: a.id });
    expect((await t.app.web.propojeni.prehled()).zrusene).toEqual([]);
  });

  it('vypnuté koncepty: nic se nezakládá, termín čeká v seznamu a jde založit ručně', async () => {
    t.app.obec.web.akce_koncepty = false;
    polozky.push(
      pol({ id: 'r40', nazev: 'Vánoční trhy', datum: den(30), cely_den: true, od: null, do: null }),
    );
    expect((await t.app.web.propojeni.synchronizuj()).zalozeno).toBe(0);
    const z = await red.get('/sprava/web/akce/zpracovani');
    expect(z.text).toContain('Termíny bez akce na webu (1)');
    const r = await red.post('/sprava/web/akce/zpracovani/koncept', { _csrf: csrfZ(z.text), ref: 'r40' });
    expect(r.url).toMatch(/\/sprava\/web\/obsah\//);
    expect((await akceRef('r40'))?.akce_cely_den).toBe(true);
    t.app.obec.web.akce_koncepty = true;
  });

  it('rozesílka z příspěvku: předvyplněné hlášení, po odeslání hlaseni_id a „Rozesláno“ u příspěvku', async () => {
    await t.db
      .insertInto('ik_odberatele')
      .values({
        jmeno: 'A',
        telefon: '+420777610900',
        email: 'a@example.cz',
        kanal: 'smisene',
        token: 'tok-ap',
        overen_at: new Date(),
      })
      .execute();
    const a = (await akceRef('e7'))!;
    const editor = await red.get(`/sprava/web/obsah/${a.id}`);
    expect(editor.text).toContain(`href="/infokanal/sprava/nove?obsah=${a.id}"`);
    const f = await red.get(`/infokanal/sprava/nove?obsah=${a.id}`);
    expect(f.text).toContain(`name="obsah_id" value="${a.id}"`);
    expect(f.text).toContain('Pozvánka: Silvestr v kulturáku');
    expect(f.text).not.toContain('name="clanek_titulek"');
    const kultura = (await t.app.infokanal.kategorie()).find((k) => k.slug === 'kultura')!;
    expect(f.text).toContain(`<option value="${kultura.id}" selected`);
    const sms = /<textarea id="sms_text"[^>]*>([^<]*)<\/textarea>/.exec(f.text)![1]!;
    expect(sms).toContain(`/akce/${a.slug}`);
    expect(('TESTOV: ' + sms.replace(/&#39;|&amp;|&quot;/g, 'x')).length).toBeLessThanOrEqual(160);
    const pole: Record<string, string> = {
      _csrf: csrfZ(f.text),
      obsah_id: a.id,
      kategorie_id: String(kultura.id),
      cil: 'vse',
    };
    for (const k of ['sms_text', 'email_predmet'])
      pole[k] = k === 'sms_text' ? 'Silvestr v kulturaku' : 'Pozvánka';
    pole.email_text = 'Přijďte';
    const r = await red.post('/infokanal/sprava/nove', pole);
    expect(r.url).toMatch(/\/infokanal\/sprava\/hlaseni\//);
    const po = (await t.app.web.obsah.podleId(a.id))!;
    expect(po.hlaseni_id).toBeTruthy();
    const pocetClanku = await t.db
      .selectFrom('web_obsah')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('zdroj', '=', 'infokanal')
      .executeTakeFirstOrThrow();
    expect(Number(pocetClanku.n)).toBe(0); // článek se nezaložil podruhé
    const editor2 = await red.get(`/sprava/web/obsah/${a.id}`);
    expect(editor2.text).toMatch(/Rozesláno .*, 1 příjemcům\./);
    expect(editor2.text).toContain(`href="/infokanal/sprava/hlaseni/${po.hlaseni_id}"`);
    // bez role redaktor tlačítko není
    const jenWeb = await prihlasSRoli(t, '777 610 002', ['web']);
    expect((await jenWeb.get(`/sprava/web/obsah/${a.id}`)).text).not.toContain('Vytvořit zprávu');
  });

  it('statistiky úvodu: každé číslo je odkaz, zprávy podle kategorie, pět nejbližších akcí', async () => {
    t.app.obec.obec.fakta = [
      { hodnota: '357', popisek: 'obyvatel', odkaz: '/ucet' },
      { hodnota: '4', popisek: 'osady', odkaz: '/obec/informace-o-obci' },
    ];
    t.app.obec.web.stat_zpravy_kategorie = 'obecni-urad';
    for (let i = 0; i < 4; i++)
      polozky.push(pol({ id: `r5${i}`, nazev: `Akce číslo ${i}`, datum: den(40 + i) }));
    const uvod = await new Prohlizec(t.base).get('/');
    expect(uvod.text).toContain('class="stat-in" href="/ucet"');
    expect(uvod.text).toContain('class="stat-in" href="/obec/informace-o-obci"');
    expect(uvod.text).toContain('class="stat-in" href="/aktuality?kategorie=obecni-urad"');
    expect(uvod.text).toContain('class="stat-in" href="/uredni-deska"');
    const akce = [...uvod.text.matchAll(/class="stat-popisek">(nejbližší|další) akce/g)];
    expect(akce.length).toBe(5);
    // každá dlaždice statistik je odkaz
    const dlazdice = uvod.text.split('class="stat-seznam"')[1]!.split('</ul>')[0]!;
    expect(dlazdice.match(/<li class="stat">/g)?.length).toBe(dlazdice.match(/<a class="stat-in"/g)?.length);
    // propojená zveřejněná akce vede na svou stránku
    const a = (await akceRef('e7'))!;
    expect(dlazdice).toContain(`href="/akce/${a.slug}"`);
  });
});
