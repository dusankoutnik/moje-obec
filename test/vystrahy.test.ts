// Automatické výstrahy infokanálu (ČHMÚ, ČEZ, SčVK): parsery nad uloženými daty zdrojů a chování podle
// VlastiKanálu nad testovací DB — pevné hodiny, podstrčený fetch, žádná síť.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import { spustTestApp, type TestApp } from './pomocnici.js';
import { OdstavkySluzba } from '../src/moduly/odstavky/sluzba.js';
import { VystrahySluzba } from '../src/moduly/infokanal/vystrahy/sluzba.js';
import { nejnovejsiSoubor, parsujCap } from '../src/moduly/infokanal/vystrahy/chmu.js';
import {
  jeNaseObec,
  obceZTitulku,
  parsujDetail,
  parsujSeznam,
} from '../src/moduly/infokanal/vystrahy/scvk.js';
import { konecNocnihoKlidu, prazskyCas, rozsah } from '../src/moduly/infokanal/vystrahy/cas.js';
import { castiObce } from '../src/moduly/infokanal/vystrahy/texty.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/vystrahy/${n}`, import.meta.url), 'utf8');
const CAP = fx('cap-leto.xml');
const VYPIS = fx('cap-vypis.html');
const BEZSTAVY = fx('bezstavy.json');
const PLAN = fx('scvk-planovane.html');
const HAV = fx('scvk-havarie.html');
const DETAIL = fx('scvk-detail.html');
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
const CASTI = ['Vlastibořice', 'Jivina', 'Sedlíšťka', 'Slavíkov'];

describe('časy v pražském pásmu', () => {
  it('SčVK časy přes letní i zimní čas', () => {
    expect(prazskyCas('3.6.2026 07:00')?.toISOString()).toBe('2026-06-03T05:00:00.000Z');
    expect(prazskyCas('11.11.2026 08:00')?.toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(prazskyCas('nesmysl')).toBeNull();
  });
  it('rozsah a noční klid (22–6 h → 6:30)', () => {
    expect(rozsah(new Date('2026-11-06T08:00Z'), new Date('2026-11-06T14:30Z'))).toBe('pá 6. 11. 9:00–15:30');
    expect(rozsah(new Date('2026-11-06T08:00Z'), null)).toBe('od pá 6. 11. 9:00 do odvolání');
    expect(konecNocnihoKlidu(new Date('2026-07-31T12:00Z'))).toBeNull();
    expect(konecNocnihoKlidu(new Date('2026-07-31T20:30Z'))?.toISOString()).toBe('2026-08-01T04:30:00.000Z');
    expect(konecNocnihoKlidu(new Date('2026-12-01T02:00Z'))?.toISOString()).toBe('2026-12-01T05:30:00.000Z');
  });
  it('části obce: všechny = celá obec, nic = celá obec', () => {
    expect(castiObce(['Jivina u Mnichova Hradiště'], CASTI)).toEqual(['Jivina']);
    expect(castiObce(['Jiná'], CASTI)).toEqual([]);
    expect(castiObce(CASTI, CASTI)).toEqual([]);
  });
});

describe('ČHMÚ CAP', () => {
  const ted = new Date('2026-07-31T19:30:00Z');
  it('vybere nejnovější soubor SIVS z výpisu', () => {
    expect(nejnovejsiSoubor(VYPIS)?.nazev).toBe('alert_cap_50_220808.xml');
  });
  it('jen česky, jen ORP obce, bez „Žádná výstraha“ a výhledu, bez skončených', () => {
    const v = parsujCap(CAP, '5109', ted);
    expect(v.map((x) => `${x.jev}|${x.stupen}`).sort()).toEqual([
      'Silné bouřky|yellow',
      'Vysoké teploty|yellow',
    ]);
    expect(v[0]!.do?.toISOString()).toBe('2026-07-31T22:00:00.000Z');
    expect(parsujCap(CAP, '5109', new Date('2026-08-02T00:00Z'))).toEqual([]);
    expect(parsujCap(CAP, '9999', ted)).toEqual([]);
  });
});

describe('SčVK HTML', () => {
  it('seznam: id, typ, časy, úryvek; cizí Jivina se nebere', () => {
    const s = parsujSeznam(PLAN);
    expect(s.length).toBe(4);
    const tr = s.find((e) => e.id === '6934')!;
    expect(tr.od?.toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(tr.typ).toBe('planovana');
    expect(obceZTitulku(tr.titulek)).toEqual(['Hrubá Skála', 'Troskovice']);
    expect(jeNaseObec(tr.titulek, 'Vlastibořice')).toBe(false);
    expect(jeNaseObec(tr.titulek, 'Troskovice')).toBe(true);
    expect(parsujSeznam(HAV).every((e) => e.typ === 'havarie')).toBe(true);
  });
  it('detail: plný text a seznam odběrných míst', () => {
    const d = parsujDetail(DETAIL);
    expect(d.text).toMatch(/Náhradní zásobování nebude/);
    expect(d.soubor).toMatch(/^https:\/\/www\.scvk\.cz\/res\/archive\/.*\.xlsx/);
  });
});

// ---- chování nad DB ----

type Odpoved = () => Response;
function sit() {
  const trasy = new Map<string, Odpoved>();
  const volani: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    volani.push(u);
    const o = trasy.get(u);
    if (!o) return new Response('nenalezeno', { status: 404 });
    return o();
  }) as typeof fetch;
  return { trasy, volani, f };
}
const text =
  (t: string, status = 200) =>
  () =>
    new Response(t, { status });

describe('výstrahy nad databází', () => {
  let t: TestApp;
  let hodiny: Date;
  let s: ReturnType<typeof sit>;
  let v: VystrahySluzba;
  let odst: OdstavkySluzba;

  const vytvor = () => {
    s = sit();
    odst = new OdstavkySluzba(
      t.db,
      { kodObce: '564516', odkazCez: 'https://example.invalid', userAgent: 'test' },
      log,
      s.f,
      () => hodiny,
    );
    v = new VystrahySluzba(
      t.db,
      t.app.infokanal,
      t.mail,
      {
        baseUrl: 'https://obec.example',
        obec: 'Vlastibořice',
        casti: CASTI,
        nazevKanalu: 'TestKanál',
        oblast: 'Turnovsko',
        chmuOrp: '5109',
        scvkObec: 'Vlastibořice',
        notify: [],
        userAgent: 'test',
      },
      log,
      odst,
      () => {},
      s.f,
      () => hodiny,
    );
  };
  const hlaseni = () => t.db.selectFrom('ik_hlaseni').selectAll().orderBy('vytvoreno_at').execute();
  const vystrahy = () => t.db.selectFrom('ik_vystrahy').selectAll().orderBy('id').execute();
  const kategorie = async (slug: string) =>
    (await t.db.selectFrom('ik_kategorie').select('id').where('slug', '=', slug).executeTakeFirstOrThrow())
      .id;

  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => {
    await t.zavri();
  });
  beforeEach(async () => {
    await t.db.deleteFrom('ik_vystrahy').execute();
    await t.db.deleteFrom('ik_vystrahy_zdroje').execute();
    await t.db.deleteFrom('ik_prijemci').execute();
    await t.db.deleteFrom('ik_hlaseni').execute();
    await t.db.deleteFrom('ik_odberatele').execute();
    await t.db.deleteFrom('nastaveni').where('klic', '=', 'odstavky_cez').execute();
    await t.db.deleteFrom('uzivatele').where('telefon', 'like', '+42077790%').execute();
    t.mail.odeslane.length = 0;
    await t.db
      .insertInto('uzivatele')
      .values({ telefon: '+420777900001', email: 'spravce@example.cz', heslo_hash: null, role: ['spravce'] })
      .execute();
    const zaklad = { kanal: 'smisene' as const, overen_at: new Date() };
    await t.db
      .insertInto('ik_odberatele')
      .values([
        {
          ...zaklad,
          jmeno: 'V',
          telefon: '+420777900101',
          email: 'v@example.cz',
          cast_obce: 'Vlastibořice',
          token: 'vy1',
        },
        { ...zaklad, jmeno: 'J', telefon: '+420777900102', email: null, cast_obce: 'Jivina', token: 'vy2' },
        { ...zaklad, jmeno: 'N', telefon: '+420777900103', email: null, cast_obce: '', token: 'vy3' },
      ])
      .execute();
    hodiny = new Date('2026-07-31T19:30:00Z'); // 21:30 v Praze
    vytvor();
  });

  const nastavCap = (xml: string, soubor = 'alert_cap_50_312101.xml') => {
    s.trasy.set(
      'https://opendata.chmi.cz/meteorology/weather/alerts/cap/',
      text(VYPIS.replaceAll('alert_cap_50_220808.xml', soubor)),
    );
    s.trasy.set(`https://opendata.chmi.cz/meteorology/weather/alerts/cap/${soubor}`, text(xml));
  };
  const oranzoveBourky = CAP.replace(
    /(<event>Silné bouřky<\/event>[\s\S]*?awareness_level<\/valueName>\s*<value>)2; yellow; Moderate/,
    '$13; orange; Severe',
  );

  it('ČHMÚ: žlutá čeká na správce (e-mail s odkazem), oranžová se rozešle sama', async () => {
    nastavCap(oranzoveBourky);
    expect(await v.zkontrolujChmu()).toBe(true);
    const r = await vystrahy();
    expect(r.map((x) => [x.externi_id, x.stav])).toEqual(
      expect.arrayContaining([
        ['Vysoké teploty|yellow', 'ceka'],
        ['Silné bouřky|orange', 'odeslano'],
      ]),
    );
    const zluta = r.find((x) => x.stupen === 'yellow')!;
    expect(
      t.mail.odeslane.some(
        (m) => m.komu === 'spravce@example.cz' && m.text.includes(`/infokanal/sprava/vystrahy/${zluta.id}`),
      ),
    ).toBe(true);
    const h = await hlaseni();
    expect(h).toHaveLength(1);
    expect(h[0]!.kategorie_id).toBe(await kategorie('pocasi'));
    expect(h[0]!.krizove).toBe(false);
    expect(h[0]!.naplanovano_na).toBeNull();
    expect(h[0]!.zdroj_automatu).toBe('chmu');
    expect(h[0]!.sms_text).toMatch(/^VÝSTRAHA ČHMÚ \(oranžová\): Silné bouřky/);
    // smíšení odběratelé dostanou výstrahu SMSkou (doručuje se jako důležité)
    const p = await t.db
      .selectFrom('ik_prijemci')
      .select('kanal')
      .where('hlaseni_id', '=', h[0]!.id)
      .execute();
    expect(p.map((x) => x.kanal)).toEqual(['sms', 'sms', 'sms']);
    expect(t.mail.odeslane.some((m) => m.predmet.includes('Automaticky rozesláno'))).toBe(true);
    // stejný soubor znovu = nic
    await v.zkontrolujChmu();
    expect(await vystrahy()).toHaveLength(2);
    expect(s.volani.filter((u) => u.endsWith('.xml'))).toHaveLength(1);
  });

  it('ČHMÚ: oranžová v noci naplánovaná na 6:30, červená krizově hned; pokračování a nižší stupeň', async () => {
    hodiny = new Date('2026-07-31T20:30:00Z'); // 22:30
    nastavCap(oranzoveBourky);
    await v.zkontrolujChmu();
    const [h] = await hlaseni();
    expect(h!.naplanovano_na?.toISOString()).toBe('2026-08-01T04:30:00.000Z');

    // nový soubor: bouřky už jen žluté (zmírnění během oranžové) + teploty prodloužené (pokračování)
    nastavCap(
      CAP.replace(/2026-08-01T00:00:00\+02:00/g, '2026-08-01T03:00:00+02:00'),
      'alert_cap_50_312200.xml',
    );
    expect(await v.zkontrolujChmu()).toBe(true);
    const r = await vystrahy();
    expect(r.find((x) => x.externi_id === 'Silné bouřky|yellow')?.stav).toBe('preskoceno');
    const teploty = r.filter((x) => x.externi_id === 'Vysoké teploty|yellow');
    expect(teploty).toHaveLength(1);
    expect(teploty[0]!.plati_do?.toISOString()).toBe('2026-08-01T01:00:00.000Z');

    // červená = krizové hlášení (kategorie krizové), bez nočního klidu
    const cervene = CAP.replace(
      /(<event>Vysoké teploty<\/event>[\s\S]*?awareness_level<\/valueName>\s*<value>)2; yellow; Moderate/,
      '$14; red; Extreme',
    );
    nastavCap(cervene, 'alert_cap_50_312300.xml');
    await v.zkontrolujChmu();
    const krizove = (await hlaseni()).find((x) => x.krizove)!;
    expect(krizove.kategorie_id).toBe(await kategorie('krizove'));
    expect(krizove.naplanovano_na).toBeNull();
  });

  it('ČHMÚ: správce žlutou rozešle (jen jednou) nebo zahodí (jen stav)', async () => {
    nastavCap(CAP);
    await v.zkontrolujChmu();
    const [a, b] = await vystrahy();
    const spravce = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777900001')
      .executeTakeFirstOrThrow();
    const r = await v.rozeslat(a!.id, spravce.id);
    expect('ok' in r).toBe(true);
    expect(await v.rozeslat(a!.id, spravce.id)).toEqual({ chyba: 'vyrizeno' });
    expect(await v.zahodit(b!.id, spravce.id)).toBe(true);
    expect((await vystrahy()).map((x) => x.stav)).toEqual(['odeslano', 'zahozeno']);
    expect(await hlaseni()).toHaveLength(1);
    // skončenou už rozeslat nejde
    await t.db.updateTable('ik_vystrahy').set({ stav: 'ceka' }).where('id', '=', b!.id).execute();
    hodiny = new Date('2026-08-02T00:00:00Z');
    expect(await v.rozeslat(b!.id, spravce.id)).toEqual({ chyba: 'skoncila' });
  });

  const nastavCez = (data: unknown) =>
    s.trasy.set(
      'https://api.bezstavy.cz/cezd/api/inspecttown/564516',
      () =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

  it('ČEZ: nová odstávka → oznámení dotčeným částem + bez části; připomínka den předem; změna a zrušení', async () => {
    hodiny = new Date('2026-10-22T05:05:00Z');
    const data = JSON.parse(BEZSTAVY) as {
      outages_in_town: { id: string; fix_expected_at: string; cancelled_at: string | null }[];
    };
    nastavCez(data);
    expect(await v.zkontrolujCez()).toBe(true);
    let h = await hlaseni();
    expect(h).toHaveLength(1); // proběhlá zrušená odstávka z července se neoznamuje
    expect(h[0]!.cil).toBe('casti');
    expect(h[0]!.cil_detail).toEqual(['Vlastibořice', '']);
    expect(h[0]!.kategorie_id).toBe(await kategorie('elektrina'));
    expect(h[0]!.sms_text).toBe(
      'Plánovaná odstávka elektřiny ČEZ: pá 6. 11. 9:00–15:30, Vlastibořice. Seznam domů: obec.example/infokanal/vystrahy',
    );
    const kontakty = await t.db
      .selectFrom('ik_prijemci')
      .select('kontakt')
      .where('hlaseni_id', '=', h[0]!.id)
      .execute();
    expect(kontakty.map((k) => k.kontakt).sort()).toEqual(['+420777900101', '+420777900103']);

    // druhá kontrola za 10 h: keš odstávek obnoví jednou, nic nového
    hodiny = new Date('2026-10-22T13:05:00Z');
    await v.zkontrolujCez();
    expect(await hlaseni()).toHaveLength(1);
    expect(s.volani).toHaveLength(2);
    // kontrola hned po předchozí → bez dotazu (keš 1 h)
    await v.zkontrolujCez();
    expect(s.volani).toHaveLength(2);

    // připomínka den předem 17:00 (jen jednou)
    hodiny = new Date('2026-11-05T16:00:00Z');
    await v.pripomenCez();
    await v.pripomenCez();
    h = await hlaseni();
    expect(h).toHaveLength(2);
    expect(h[1]!.sms_text).toMatch(/^Připomínáme: ZÍTRA odstávka elektřiny/);

    // změna termínu
    hodiny = new Date('2026-11-05T17:05:00Z');
    data.outages_in_town[0]!.fix_expected_at = '2026-11-06T15:30:00Z';
    nastavCez(data);
    await v.zkontrolujCez();
    h = await hlaseni();
    expect(h.at(-1)!.sms_text).toMatch(/^ZMĚNA odstávky elektřiny ČEZ: pá 6. 11. 9:00–16:30/);
    // zrušení
    hodiny = new Date('2026-11-05T19:05:00Z');
    data.outages_in_town[0]!.cancelled_at = '2026-11-05T19:00:00Z';
    nastavCez(data);
    await v.zkontrolujCez();
    h = await hlaseni();
    expect(h.at(-1)!.sms_text).toMatch(/^ZRUŠENA odstávka elektřiny/);
    expect(h).toHaveLength(4);
    // po zrušení už nic
    hodiny = new Date('2026-11-05T21:05:00Z');
    await v.zkontrolujCez();
    expect(await hlaseni()).toHaveLength(4);
  });

  it('ČEZ: chyba zdroje (429) = žádné zprávy; po 24 h bez úspěchu jedno upozornění správcům', async () => {
    hodiny = new Date('2026-10-22T05:05:00Z');
    s.trasy.set(
      'https://api.bezstavy.cz/cezd/api/inspecttown/564516',
      () => new Response('', { status: 429 }),
    );
    expect(await v.zkontrolujCez()).toBe(false);
    hodiny = new Date('2026-10-23T08:05:00Z'); // 27 h (429 pauza 3 h už vypršela, dotaz znovu selže)
    expect(await v.zkontrolujCez()).toBe(false);
    hodiny = new Date('2026-10-23T15:05:00Z');
    expect(await v.zkontrolujCez()).toBe(false);
    const upozorneni = t.mail.odeslane.filter((m) => m.predmet.includes('nefunguje'));
    expect(upozorneni).toHaveLength(1);
    expect(await hlaseni()).toHaveLength(0);
  });

  const NASE = `<a class="component__item is-shutdown" href="/udalosti/planovane-odstavky/okres-semily-obec-vlastiborice-cast-obce-jivina-7001" title="x">
    <h3 class="is-label">Okres Semily, obec Vlastibořice, část obce Jivina</h3>
    <div class="is-info">Zveřejněno: 20.10.2026 10:00</div>
    <div class="is-info"><span>4.11.2026 08:00 - 4.11.2026 12:00</span></div>
    <div class="is-text"><p>Z důvodu prací bude přerušena dodávka…</p></div></a>`;
  const nastavScvk = (plan: string, detail: Odpoved) => {
    s.trasy.set(
      'https://www.scvk.cz/vodovody-a-kanalizace/odstavky-a-havarie/planovane-odstavky/',
      text(plan),
    );
    s.trasy.set('https://www.scvk.cz/vodovody-a-kanalizace/odstavky-a-havarie/havarie/', text(HAV));
    s.trasy.set(
      'https://www.scvk.cz/udalosti/planovane-odstavky/okres-semily-obec-vlastiborice-cast-obce-jivina-7001',
      detail,
    );
  };

  it('SčVK: nová odstávka (plný text z detailu, cílení na Jivinu), připomínka, zrušení = zmizení + 404', async () => {
    hodiny = new Date('2026-10-22T08:07:00Z');
    nastavScvk(
      PLAN.replace('<div class="component__list">', `<div class="component__list">\n${NASE}`),
      text(DETAIL),
    );
    expect(await v.zkontrolujScvk()).toBe(true);
    let h = await hlaseni();
    expect(h).toHaveLength(1);
    expect(h[0]!.cil_detail).toEqual(['Jivina', '']);
    expect(h[0]!.kategorie_id).toBe(await kategorie('voda'));
    expect(h[0]!.sms_text).toBe(
      'Plánovaná odstávka vody SčVK: st 4. 11. 8:00–12:00, Jivina. Náhradní zásobování nebude. Podrobnosti: obec.example/infokanal/vystrahy',
    );
    expect(h[0]!.email_text).toMatch(/Seznam dotčených odběrných míst: https:\/\/www\.scvk\.cz\/res\//);
    // cizí Jivina (obec Troskovice) se nepočítá — jen jedna událost
    expect(await vystrahy()).toHaveLength(1);

    // zmizí ze seznamu, ale detail ještě je → nic
    nastavScvk(PLAN, text(DETAIL));
    await v.zkontrolujScvk();
    expect(await hlaseni()).toHaveLength(1);

    hodiny = new Date('2026-11-03T16:02:00Z');
    nastavScvk(
      PLAN.replace('<div class="component__list">', `<div class="component__list">\n${NASE}`),
      text(DETAIL),
    );
    await v.pripomenScvk();
    expect((await hlaseni()).at(-1)!.sms_text).toMatch(/^Připomínáme: ZÍTRA odstávka vody/);

    // zmizí a detail vrací 404 → zrušeno (před začátkem)
    nastavScvk(PLAN, text('', 404));
    await v.zkontrolujScvk();
    h = await hlaseni();
    expect(h).toHaveLength(3);
    expect(h.at(-1)!.sms_text).toMatch(/^ZRUŠENA odstávka vody/);
    expect((await vystrahy())[0]!.zruseno_at).not.toBeNull();
  });

  it('veřejný přehled a správa', async () => {
    hodiny = new Date();
    nastavCez(JSON.parse(BEZSTAVY));
    // vlastní hodiny jen pro tento test: odstávka v listopadu 2026 musí být v budoucnu i podle skutečného času
    hodiny = new Date('2026-10-22T05:05:00Z');
    await v.zkontrolujCez();
    const r = await fetch(`${t.base}/infokanal/vystrahy`);
    expect(r.status).toBe(200);
    const html = await r.text();
    if (Date.now() < Date.parse('2026-11-06T14:30:00Z')) expect(html).toContain('Odstávka elektřiny');
    const sprava = await fetch(`${t.base}/infokanal/sprava/vystrahy`, { redirect: 'manual' });
    expect(sprava.status).toBe(302); // jen přihlášený redaktor
  });
});
