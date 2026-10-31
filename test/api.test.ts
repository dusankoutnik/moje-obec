// API pro integrace (/api/v1): tokeny a rozsahy, příspěvky (koncept/zveřejnění, sanitace, idempotence, PATCH),
// soubory, úřední deska (zákonné lhůty), rozeslání infokanálem, zpravodaj (počet obyvatel v úvodu, akce), správa
// tokenů, dokumentace a OpenAPI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datumPraha } from '../src/lib/datum.js';
import { markdownNaHtml } from '../src/moduly/api/markdown.js';
import { hashTokenu, type Rozsah } from '../src/moduly/api/tokeny.js';
import { csrfZ, MALE_PDF, prihlasSRoli, spustTestApp, type TestApp } from './pomocnici.js';

const den = (n: number) => datumPraha(new Date(Date.now() + n * 86_400_000));
// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let t: TestApp;
let adminId: string;
const tokeny: Record<string, string> = {};

async function token(rozsahy: Rozsah[]) {
  const { token } = await t.app.apiTokeny.zaloz(`test ${rozsahy.join(',')}`, rozsahy, adminId);
  return token;
}

async function api(
  metoda: string,
  cesta: string,
  tok: string | null,
  telo?: Record<string, unknown> | FormData,
): Promise<{ status: number; json: Record<string, unknown> & { chyba?: string; pole?: string } }> {
  const headers: Record<string, string> = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  let body: string | FormData | undefined;
  if (telo instanceof FormData) body = telo;
  else if (telo) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(telo);
  }
  const res = await fetch(t.base + cesta, { method: metoda, headers, body });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function fd(
  pole: Record<string, string>,
  soubory: { pole: string; nazev: string; data: Buffer; typ: string }[] = [],
) {
  const f = new FormData();
  for (const [k, v] of Object.entries(pole)) f.append(k, v);
  for (const s of soubory) f.append(s.pole, new Blob([s.data], { type: s.typ }), s.nazev);
  return f;
}

beforeAll(async () => {
  t = await spustTestApp();
  const u = await t.db
    .insertInto('uzivatele')
    .values({ telefon: '+420777100100', role: ['admin'] as never, jmeno: 'Ada', prijmeni: 'Správcová' })
    .returning('id')
    .executeTakeFirstOrThrow();
  adminId = u.id;
  tokeny.obsah = await token(['obsah:zapis']);
  tokeny.cteni = await token(['obsah:cteni']);
  tokeny.deska = await token(['deska:zapis']);
  tokeny.rozeslat = await token(['infokanal:rozeslat']);
  tokeny.zpravodaj = await token(['zpravodaj', 'infokanal:rozeslat']);
  tokeny.zpravodajBez = await token(['zpravodaj']);
});
afterAll(async () => t?.zavri());

describe('tokeny a rozsahy', () => {
  it('bez tokenu 401, neplatný 401, cizí rozsah 403, platný 200', async () => {
    expect((await api('GET', '/api/v1/kategorie', null)).status).toBe(401);
    const spatny = await api('GET', '/api/v1/kategorie', 'wov_neexistuje');
    expect(spatny.status).toBe(401);
    expect(spatny.json.chyba).toMatch(/Neplatný/);
    expect((await api('POST', '/api/v1/prispevky', tokeny.cteni!, { titulek: 'x' })).status).toBe(403);
    const ok = await api('GET', '/api/v1/kategorie', tokeny.cteni!);
    expect(ok.status).toBe(200);
    expect((ok.json.web as { slug: string }[]).some((k) => k.slug === 'zpravodaj')).toBe(true);
    expect((ok.json.deska as { slug: string }[]).some((k) => k.slug === 'vyhlasky')).toBe(true);
  });
  it('v DB je jen hash, poslední použití se zapíše, zrušený token neplatí', async () => {
    const tok = await token(['obsah:cteni']);
    const r = await t.db
      .selectFrom('api_tokeny')
      .selectAll()
      .where('hash', '=', hashTokenu(tok))
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(r)).not.toContain(tok);
    await api('GET', '/api/v1/kategorie', tok);
    const po = await t.db
      .selectFrom('api_tokeny')
      .selectAll()
      .where('id', '=', r.id)
      .executeTakeFirstOrThrow();
    expect(po.posledni_pouziti_at).not.toBeNull();
    expect(po.pouziti).toBe(1);
    await t.app.apiTokeny.zrus(r.id, adminId);
    expect((await api('GET', '/api/v1/kategorie', tok)).status).toBe(401);
  });
  it('multipart bez platného tokenu se odmítne ještě před čtením těla', async () => {
    const r = await api(
      'POST',
      '/api/v1/soubory',
      'wov_spatny',
      fd({}, [{ pole: 'soubor', nazev: 'a.pdf', data: MALE_PDF, typ: 'application/pdf' }]),
    );
    expect(r.status).toBe(401);
  });
  it('neznámý endpoint vrací JSON 404', async () => {
    const r = await api('GET', '/api/v1/neexistuje', tokeny.cteni!);
    expect(r.status).toBe(404);
    expect(r.json.chyba).toBeTruthy();
  });
});

describe('příspěvky', () => {
  it('koncept bez zverejnit, sanitace HTML, kategorie podle slugu', async () => {
    const r = await api('POST', '/api/v1/prispevky', tokeny.obsah!, {
      titulek: 'Nová zpráva',
      perex: 'Krátce',
      html: '<p onclick="x()">Ahoj <script>alert(1)</script><strong>světe</strong></p>',
      kategorie: 'obecni-urad',
    });
    expect(r.status).toBe(201);
    expect(r.json.stav).toBe('koncept');
    expect(r.json.kategorie).toBe('obecni-urad');
    const o = await t.app.web.obsah.podleId(r.json.id as string);
    expect(o!.obsah_html).toBe('<p>Ahoj <strong>světe</strong></p>');
    expect(o!.zdroj).toBe('api');
    // koncept na webu není
    expect((await fetch(`${t.base}/aktuality/${o!.slug}`)).status).toBe(404);
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('akce', '=', 'api.prispevek_zalozen')
      .execute();
    expect(audit.length).toBeGreaterThan(0);
    const rev = await t.db.selectFrom('web_revize').selectAll().where('obsah_id', '=', o!.id).execute();
    expect(rev.length).toBe(1);
  });
  it('zveřejnění, markdown a neplatná data s polem', async () => {
    const r = await api('POST', '/api/v1/prispevky', tokeny.obsah!, {
      titulek: 'Zveřejněná zpráva',
      markdown: '# Nadpis\n\nText s **tučným** a [odkazem](https://example.cz).\n\n- a\n- b',
      zverejnit: true,
    });
    expect(r.status).toBe(201);
    expect(r.json.stav).toBe('zverejneno');
    const o = await t.app.web.obsah.podleId(r.json.id as string);
    expect(o!.obsah_html).toContain('<h2>Nadpis</h2>');
    expect(o!.obsah_html).toContain('<strong>tučným</strong>');
    expect(o!.obsah_html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect((await fetch(`${t.base}/aktuality/${o!.slug}`)).status).toBe(200);
    const spatne = await api('POST', '/api/v1/prispevky', tokeny.obsah!, { titulek: 'x', kategorie: 'neni' });
    expect(spatne.status).toBe(400);
    expect(spatne.json.pole).toBe('kategorie');
    expect((await api('POST', '/api/v1/prispevky', tokeny.obsah!, { perex: 'bez titulku' })).json.pole).toBe(
      'titulek',
    );
    const bezAlt = await api('POST', '/api/v1/prispevky', tokeny.obsah!, {
      titulek: 'Obrázek',
      html: '<p><img src="https://example.cz/a.jpg"></p>',
      zverejnit: true,
    });
    expect(bezAlt.status).toBe(400);
    expect(bezAlt.json.pole).toBe('html');
    expect(
      (await api('POST', '/api/v1/prispevky', tokeny.obsah!, { titulek: 'x', zdroj: 'import' })).json.pole,
    ).toBe('zdroj');
  });
  it('idempotence: stejný zdroj + externi_id upraví, ne zduplikuje; GET podle externího id', async () => {
    const telo = {
      typ: 'akce',
      titulek: 'Drakiáda',
      akce_od: `${den(10)}T14:00`,
      misto: 'hřiště',
      zdroj: 'kalendar',
      externi_id: 'd-1',
    };
    const a = await api('POST', '/api/v1/prispevky', tokeny.obsah!, telo);
    expect(a.status).toBe(201);
    const b = await api('POST', '/api/v1/prispevky', tokeny.obsah!, {
      ...telo,
      titulek: 'Drakiáda 2026',
      zverejnit: true,
    });
    expect(b.status).toBe(200);
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.aktualizovano).toBe(true);
    expect(b.json.stav).toBe('zverejneno');
    expect(b.json.misto).toBe('hřiště');
    const n = await t.db.selectFrom('web_obsah').select('id').where('externi_id', '=', 'd-1').execute();
    expect(n.length).toBe(1);
    const g = await api('GET', '/api/v1/prispevky?zdroj=kalendar&externi_id=d-1', tokeny.cteni!);
    expect((g.json.polozky as { titulek: string }[])[0]!.titulek).toBe('Drakiáda 2026');
    // jiný typ se stejným id = konflikt
    expect(
      (await api('POST', '/api/v1/prispevky', tokeny.obsah!, { ...telo, typ: 'aktualita' })).status,
    ).toBe(409);
  });
  it('PATCH: rozpracovaná změna zveřejněného, jen API obsah', async () => {
    const a = await api('POST', '/api/v1/prispevky', tokeny.obsah!, { titulek: 'Původní', zverejnit: true });
    const p = await api('PATCH', `/api/v1/prispevky/${a.json.id}`, tokeny.obsah!, {
      titulek: 'Změna',
      zverejnit: false,
    });
    expect(p.status).toBe(200);
    expect(p.json.titulek).toBe('Původní');
    expect(p.json.rozpracovana_zmena).toBe(true);
    const p2 = await api('PATCH', `/api/v1/prispevky/${a.json.id}`, tokeny.obsah!, { perex: 'nový perex' });
    expect(p2.json.perex).toBe('nový perex');
    expect(p2.json.stav).toBe('zverejneno');
    // obsah redakce (zdroj '') token měnit nesmí
    const redakce = await t.app.web.obsah.uloz(
      null,
      'stranka',
      { ...(await import('../src/moduly/web/obsah.js')).PRAZDNA_POLE, titulek: 'Stránka' },
      'zverejnit',
      adminId,
    );
    expect(
      (await api('PATCH', `/api/v1/prispevky/${redakce}`, tokeny.obsah!, { titulek: 'hack' })).status,
    ).toBe(403);
    expect(
      (await api('PATCH', `/api/v1/prispevky/00000000-0000-0000-0000-000000000000`, tokeny.obsah!, {}))
        .status,
    ).toBe(404);
  });
  it('multipart: úvodní obrázek s popisem a přílohy ke stažení', async () => {
    const r = await api(
      'POST',
      '/api/v1/prispevky',
      tokeny.obsah!,
      fd({ titulek: 'S obrázkem', html: '<p>Text</p>', obrazek_alt: 'Mapa obce', zverejnit: 'true' }, [
        { pole: 'obrazek', nazev: 'mapa.png', data: PNG, typ: 'image/png' },
        { pole: 'prilohy', nazev: 'rozhodnuti.pdf', data: MALE_PDF, typ: 'application/pdf' },
      ]),
    );
    expect(r.status).toBe(201);
    expect(r.json.obrazek_id).toBeTruthy();
    const o = await t.app.web.obsah.podleId(r.json.id as string);
    expect(o!.obsah_html).toContain('Ke stažení');
    expect(o!.obsah_html).toContain('rozhodnuti.pdf');
    const bezPopisu = await api(
      'POST',
      '/api/v1/prispevky',
      tokeny.obsah!,
      fd({ titulek: 'Bez popisu', zverejnit: 'true' }, [
        { pole: 'obrazek', nazev: 'x.png', data: PNG, typ: 'image/png' },
      ]),
    );
    expect(bezPopisu.status).toBe(400);
    expect(bezPopisu.json.pole).toBe('obrazek_alt');
  });
});

describe('soubory a deska', () => {
  it('POST /soubory → id, URL a zařazení textu', async () => {
    const r = await api(
      'POST',
      '/api/v1/soubory',
      tokeny.obsah!,
      fd({}, [{ pole: 'soubor', nazev: 'vyhlaska.pdf', data: MALE_PDF, typ: 'application/pdf' }]),
    );
    expect(r.status).toBe(201);
    expect(r.json.url).toMatch(/\/soubory\/.+vyhlaska\.pdf$/);
    const text = await t.db
      .selectFrom('soubory_text')
      .selectAll()
      .where('soubor_id', '=', r.json.id as string)
      .executeTakeFirst();
    expect(text).toBeTruthy();
    expect((await api('POST', '/api/v1/soubory', tokeny.obsah!, fd({ a: 'b' }))).status).toBe(400);
    expect(
      (
        await api(
          'POST',
          '/api/v1/soubory',
          tokeny.rozeslat!,
          fd({}, [{ pole: 'soubor', nazev: 'a.pdf', data: MALE_PDF, typ: 'application/pdf' }]),
        )
      ).status,
    ).toBe(403);
  });
  it('deska: vyvěšení s přílohou, kontrola lhůt a minulosti', async () => {
    const r = await api(
      'POST',
      '/api/v1/deska',
      tokeny.deska!,
      fd({ nazev: 'Vyhláška o odpadech', kategorie: 'vyhlasky', popis: 'popis' }, [
        { pole: 'prilohy', nazev: 'v.pdf', data: MALE_PDF, typ: 'application/pdf' },
      ]),
    );
    expect(r.status).toBe(201);
    expect(r.json.vyveseno_do).toBe(den(15));
    expect((r.json.prilohy as unknown[]).length).toBe(1);
    expect((await fetch(`${t.base}/uredni-deska/${r.json.id}`)).status).toBe(200);
    const kratke = await api(
      'POST',
      '/api/v1/deska',
      tokeny.deska!,
      fd({ nazev: 'Krátká', kategorie: 'vyhlasky', vyveseno_do: den(3) }),
    );
    expect(kratke.status).toBe(400);
    expect(kratke.json.chyba).toMatch(/15 dní/);
    const minulost = await api(
      'POST',
      '/api/v1/deska',
      tokeny.deska!,
      fd({ nazev: 'Zpětně', kategorie: 'vyhlasky', vyveseno_od: den(-2) }),
    );
    expect(minulost.json.pole).toBe('vyveseno_od');
    expect(
      (await api('POST', '/api/v1/deska', tokeny.deska!, fd({ nazev: 'X', kategorie: 'neni' }))).json.pole,
    ).toBe('kategorie');
    expect(
      (await api('POST', '/api/v1/deska', tokeny.obsah!, fd({ nazev: 'X', kategorie: 'vyhlasky' }))).status,
    ).toBe(403);
  });
  it('deska: rozpočet, který by sejmul starší, chce potvrzení (409)', async () => {
    // starší rozpočet vyvěšený včera (přes API zpětně nejde — vloží ho služba)
    const kat = (await t.app.deska.kategorie()).find((k) => k.slug === 'rozpocet')!;
    const prvniId = await t.app.deska.uloz(
      null,
      {
        nazev: 'Rozpočet 2026',
        kategorieId: kat.id,
        cisloJednaci: '',
        puvodce: '',
        popis: '',
        od: den(-1),
        do: null,
        typRozpoctu: 'rozpocet',
        rok: 2026,
      },
      adminId,
    );
    const prvni = { json: { id: prvniId } };
    const druhy = fd({
      nazev: 'Rozpočet 2027',
      kategorie: 'rozpocet',
      typ_rozpoctu: 'rozpocet',
      rok: '2027',
      do_odvolani: 'true',
    });
    const r = await api('POST', '/api/v1/deska', tokeny.deska!, druhy);
    expect(r.status).toBe(409);
    expect((r.json.sejme as { id: string }[])[0]!.id).toBe(prvni.json.id);
    const ok = await api(
      'POST',
      '/api/v1/deska',
      tokeny.deska!,
      fd({
        nazev: 'Rozpočet 2027',
        kategorie: 'rozpocet',
        typ_rozpoctu: 'rozpocet',
        rok: '2027',
        do_odvolani: 'true',
        potvrdit_nahrazeni: 'true',
      }),
    );
    expect(ok.status).toBe(201);
    expect(ok.json.sejmuto).toEqual([prvni.json.id]);
  });
});

describe('rozeslání infokanálem', () => {
  it('jen zveřejněný příspěvek, e-mail bez SMS, hlášení se zapíše k příspěvku', async () => {
    await t.db
      .insertInto('ik_odberatele')
      .values({
        jmeno: 'Odběratel',
        email: 'odber@example.cz',
        telefon: '+420777200200',
        kanal: 'mixed',
        token: 'tok-api-1',
        overen_at: new Date(),
      })
      .execute();
    const koncept = await api('POST', '/api/v1/prispevky', tokeny.obsah!, { titulek: 'Koncept' });
    expect(
      (await api('POST', `/api/v1/prispevky/${koncept.json.id}/rozeslat`, tokeny.rozeslat!, {})).status,
    ).toBe(409);
    const z = await api('POST', '/api/v1/prispevky', tokeny.obsah!, {
      titulek: 'Svoz odpadu',
      perex: 'Ve středu',
      zverejnit: true,
    });
    expect((await api('POST', `/api/v1/prispevky/${z.json.id}/rozeslat`, tokeny.obsah!, {})).status).toBe(
      403,
    );
    const r = await api('POST', `/api/v1/prispevky/${z.json.id}/rozeslat`, tokeny.rozeslat!, {});
    expect(r.status).toBe(202);
    expect(r.json.prijemcu).toBe(1);
    const h = await t.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .where('id', '=', r.json.hlaseni_id as string)
      .executeTakeFirstOrThrow();
    expect(h.sms_text).toBeNull();
    expect(h.email_predmet).toBe('Svoz odpadu');
    expect(h.email_text).toContain('/aktuality/');
    const o = await t.app.web.obsah.podleId(z.json.id as string);
    expect(o!.hlaseni_id).toBe(r.json.hlaseni_id);
  });
});

describe('zpravodaj', () => {
  const meta = (o: Record<string, unknown> = {}) => ({
    rocnik: 2026,
    cislo: 3,
    vydano: '2026-09-08',
    obdobi: 'září 2026',
    perex: 'Volby 2026, posilovna v KD.',
    obsah: [
      { strana: 2, nadpis: 'Úvodník & info OÚ' },
      { strana: 4, nadpis: 'Volby 2026' },
    ],
    evidence: { k: '2026-08-31', obyvatel: 353, pred_rokem: 344, pred_10_lety: null, prihlaseni: 5 },
    hospodareni: {
      k: '2026-08-31',
      prijmy: 8187503.46,
      vydaje: 6930504.52,
      saldo: 1256998.94,
      zustatek_ucet: null,
    },
    akce: [
      {
        nazev: 'Obecní výlet – zámek Litomyšl',
        datum: den(20),
        od: '07:30',
        misto: 'odjezd DPS',
        poznamka: 'přihlášky na OÚ',
      },
      { nazev: 'Stará akce', datum: '2020-01-01' },
      {
        nazev: 'Powerjóga',
        pravidelne: 'každé pondělí',
        od: '18:30',
        misto: 'KD',
        odkaz: 'https://www.example.cz',
      },
    ],
    tiraz: { vydavatel: 'Obec Testov', redakce_email: 'zpravodaj@testov.cz', evidence_mk: 'MK ČR E 1' },
    zverejnit: true,
    rozeslat: true,
    ...o,
  });
  const odeslat = (tok: string, m: Record<string, unknown>, jakoSoubor = false) =>
    api(
      'POST',
      '/api/v1/zpravodaj',
      tok,
      fd(jakoSoubor ? {} : { metadata: JSON.stringify(m) }, [
        ...(jakoSoubor
          ? [
              {
                pole: 'metadata',
                nazev: 'm.json',
                data: Buffer.from(JSON.stringify(m)),
                typ: 'application/json',
              },
            ]
          : []),
        { pole: 'pdf', nazev: '2026-03-web.pdf', data: MALE_PDF, typ: 'application/pdf' },
        { pole: 'obalka', nazev: 'obalka.png', data: PNG, typ: 'image/png' },
      ]),
    );

  it('validace metadat (pole) a PDF povinné', async () => {
    const r = await odeslat(tokeny.zpravodaj!, meta({ evidence: { k: '2026-08-31' } }));
    expect(r.status).toBe(400);
    expect(r.json.pole).toBe('metadata.evidence.obyvatel');
    const bezPdf = await api(
      'POST',
      '/api/v1/zpravodaj',
      tokeny.zpravodaj!,
      fd({ metadata: JSON.stringify(meta()) }),
    );
    expect(bezPdf.json.pole).toBe('pdf');
    expect((await odeslat(tokeny.obsah!, meta())).status).toBe(403);
  });

  it('příspěvek s obsahem, tabulkami a tiráží; obyvatel v úvodu; akce jako koncepty; rozeslání', async () => {
    const pred = await (await fetch(`${t.base}/`)).text();
    expect(pred).not.toContain('podle Zpravodaje');
    const r = await odeslat(tokeny.zpravodaj!, meta(), true);
    expect(r.status).toBe(201);
    expect(r.json.stav).toBe('zverejneno');
    expect(r.json.url).toMatch(/\/aktuality\/obecni-zpravodaj-2026-3$/);
    const o = await t.app.web.obsah.podleId(r.json.id as string);
    expect(o!.zdroj).toBe('zpravodaj');
    expect(o!.obrazek_id).toBeTruthy();
    expect(o!.obsah_html).toContain('V tomto čísle');
    expect(o!.obsah_html).toContain('Úvodník &amp; info OÚ');
    expect(o!.obsah_html).toContain('Z evidence obyvatel k 31. 8. 2026');
    expect(o!.obsah_html).toMatch(/353/);
    expect(o!.obsah_html).toContain('Hospodaření obce');
    expect(o!.obsah_html).not.toContain('Zůstatek na účtu');
    expect(o!.obsah_html).toContain('Powerjóga');
    expect(o!.obsah_html).toContain('mailto:zpravodaj@testov.cz');
    expect(o!.obsah_html).toContain('MK ČR E 1');
    const kat = (await t.app.web.obsah.kategorie()).find((k) => k.slug === 'zpravodaj');
    expect(o!.kategorie_id).toBe(kat!.id);
    const akce = r.json.akce as { nazev: string; stav: string; id?: string }[];
    expect(akce.map((a) => a.stav)).toEqual(['koncept', 'probehla', 'pravidelna']);
    const koncept = await t.app.web.obsah.podleId(akce[0]!.id!);
    expect(koncept!.stav).toBe('koncept');
    expect(koncept!.akce_misto).toBe('odjezd DPS');
    expect(r.json.rozeslano).toBeTruthy();
    const uvod = await (await fetch(`${t.base}/`)).text();
    expect(uvod).toContain('podle Zpravodaje 3/2026 (k 31. 8. 2026)');
    expect(uvod).toMatch(/data-cislo="353"/);
  });

  it('idempotence: stejné číslo = úprava, akce ani rozeslání se neopakují; novější číslo mění obyvatele', async () => {
    const r = await odeslat(
      tokeny.zpravodaj!,
      meta({ perex: 'Opravený perex', evidence: { k: '2026-08-31', obyvatel: 354 } }),
    );
    expect(r.status).toBe(200);
    expect(r.json.aktualizovano).toBe(true);
    expect((r.json.akce as { stav: string }[])[0]!.stav).toBe('existuje');
    expect(r.json.rozeslano).toBeNull();
    expect(r.json.poznamka).toMatch(/už bylo rozesláno/);
    const cisla = await t.db.selectFrom('web_zpravodaj').selectAll().execute();
    expect(cisla.length).toBe(1);
    expect(cisla[0]!.obyvatel).toBe(354);
    const n = await t.db
      .selectFrom('web_obsah')
      .select('id')
      .where('zdroj', '=', 'zpravodaj')
      .where('typ', '=', 'aktualita')
      .execute();
    expect(n.length).toBe(1);
    // koncept dalšího čísla se do úvodu nepočítá
    await odeslat(
      tokeny.zpravodajBez!,
      meta({
        cislo: 4,
        vydano: '2026-12-01',
        evidence: { k: '2026-11-30', obyvatel: 360 },
        zverejnit: false,
        akce: [],
      }),
    );
    expect(await (await fetch(`${t.base}/`)).text()).toMatch(/data-cislo="354"/);
    const r5 = await odeslat(
      tokeny.zpravodajBez!,
      meta({ cislo: 4, vydano: '2026-12-01', evidence: { k: '2026-11-30', obyvatel: 360 }, akce: [] }),
    );
    expect(r5.json.poznamka).toMatch(/infokanal:rozeslat/);
    const uvod = await (await fetch(`${t.base}/`)).text();
    expect(uvod).toMatch(/data-cislo="360"/);
    expect(uvod).toContain('podle Zpravodaje 4/2026');
  });
});

describe('správa tokenů, dokumentace, patička', () => {
  it('admin založí token (ukáže se jednou), zruší; ne-admin 403', async () => {
    const p = await prihlasSRoli(t, '777300300', ['admin']);
    const s = await p.get('/sprava/api');
    expect(s.res.status).toBe(200);
    const po = await p.post('/sprava/api', {
      _csrf: csrfZ(s.text),
      nazev: 'Sazba',
      rozsahy: ['zpravodaj', 'neexistuje'],
    });
    const m = /<code class="api-token">(wov_[^<]+)<\/code>/.exec(po.text);
    expect(m).toBeTruthy();
    expect((await api('GET', '/api/v1/kategorie', m![1]!)).status).toBe(200);
    expect((await api('POST', '/api/v1/prispevky', m![1]!, { titulek: 'x' })).status).toBe(403);
    const r = await t.db
      .selectFrom('api_tokeny')
      .selectAll()
      .where('nazev', '=', 'Sazba')
      .executeTakeFirstOrThrow();
    expect(r.rozsahy).toEqual(['zpravodaj']);
    const seznam = await p.get('/sprava/api');
    expect(seznam.text).not.toContain(m![1]!);
    await p.post(`/sprava/api/${r.id}/zrusit`, { _csrf: csrfZ(seznam.text) });
    expect((await api('GET', '/api/v1/kategorie', m![1]!)).status).toBe(401);
    const red = await prihlasSRoli(t, '777300301', ['spravce']);
    expect((await red.get('/sprava/api')).res.status).toBe(403);
  });
  it('Swagger UI /api, textová dokumentace, OpenAPI a odkaz v patičce', async () => {
    const sw = await fetch(`${t.base}/api`);
    expect(sw.status).toBe(200);
    const swh = await sw.text();
    expect(swh).toContain('data-openapi="/api/openapi.json"');
    expect(swh).toContain('/static/vendor/swagger/swagger-ui-bundle.js');
    expect(swh).not.toContain('cdn.'); // žádné CDN
    expect((await fetch(`${t.base}/static/vendor/swagger/swagger-ui-bundle.js`)).status).toBe(200);
    expect((await fetch(`${t.base}/static/vendor/swagger/swagger-ui.css`)).status).toBe(200);
    expect((await fetch(`${t.base}/static/vendor/swagger/index.html`)).status).toBe(404); // jen dva soubory
    const d = await fetch(`${t.base}/api/dokumentace`);
    expect(d.status).toBe(200);
    const h = await d.text();
    expect(h).toContain('Authorization: Bearer');
    expect(h).toContain('/api/v1/zpravodaj');
    const o = (await (await fetch(`${t.base}/api/openapi.json`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(o.openapi).toBe('3.1.0');
    expect(Object.keys(o.paths)).toEqual(
      expect.arrayContaining(['/prispevky', '/deska', '/soubory', '/zpravodaj', '/prispevky/{id}/rozeslat']),
    );
    expect(h).toMatch(/<a href="\/api">API<\/a>/);
  });
});

describe('markdown', () => {
  it('nadpisy, seznamy, citace, odkazy, escapování', () => {
    expect(markdownNaHtml('# A\n## B\n### C')).toBe('<h2>A</h2>\n<h2>B</h2>\n<h3>C</h3>');
    expect(markdownNaHtml('1. jedna\n2. dvě')).toBe('<ol><li>jedna</li><li>dvě</li></ol>');
    expect(markdownNaHtml('> cit')).toBe('<blockquote><p>cit</p></blockquote>');
    expect(markdownNaHtml('<b>x</b> *k*')).toBe('<p>&lt;b&gt;x&lt;/b&gt; <em>k</em></p>');
    expect(markdownNaHtml('---')).toBe('<hr>');
  });
});
