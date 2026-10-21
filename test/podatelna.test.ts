// Elektronická podatelna: kontrola formuláře (bez DB), veřejné podání (uložení, číslo, e-mail úřadu s Reply-To,
// potvrzení podateli), past na roboty, CSRF, limit podle IP a správa (jen správce, vyřízení, nic se nemaže).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { obecZObjektu } from '../src/config/obec.js';
import { adresaPodatelny, cisloPodani, overFormular, uchovatDo } from '../src/moduly/podatelna/sluzba.js';
import { csrfZ, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

const PLNE = {
  jmeno: 'Jan Testovací',
  ulice: 'Testov 12',
  obec: 'Testov',
  psc: '46344',
  telefon: '777 123 456',
  email: 'Jan.Test@Example.cz',
  predmet: 'Žádost o vyjádření',
  text: 'Dobrý den,\r\nžádám o vyjádření.\r\n\r\nDěkuji',
  beru_na_vedomi: 'ano',
};

describe('kontrola formuláře (bez DB)', () => {
  it('platné podání: normalizace PSČ, telefonu, e-mailu a konců řádků', () => {
    const v = overFormular(PLNE);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.udaje.psc).toBe('463 44');
    expect(v.udaje.telefon).toBe('+420777123456');
    expect(v.udaje.email).toBe('jan.test@example.cz');
    expect(v.udaje.text).toBe('Dobrý den,\nžádám o vyjádření.\n\nDěkuji');
  });

  it('povinná pole, formát PSČ/telefonu/e-mailu a potvrzení', () => {
    const v = overFormular({ telefon: 'abc', email: 'neni-email', psc: '123' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.chyby).sort()).toEqual(
      ['beru_na_vedomi', 'email', 'jmeno', 'obec', 'predmet', 'psc', 'telefon', 'text', 'ulice'].sort(),
    );
  });

  it('telefon a e-mail jsou nepovinné', () => {
    const v = overFormular({ ...PLNE, telefon: '', email: '' });
    expect(v.ok && v.udaje.telefon === '' && v.udaje.email === '').toBe(true);
  });

  it('předmět je jeden řádek (žádné vložení hlavičky do e-mailu)', () => {
    const v = overFormular({ ...PLNE, predmet: 'Ahoj\r\nBcc: zlo@example.cz' });
    expect(v.ok && v.udaje.predmet).toBe('Ahoj Bcc: zlo@example.cz');
  });

  it('číslo podání, doba uchování a adresa podatelny', () => {
    expect(cisloPodani(2026, 7)).toBe('EP-2026-0007');
    expect(uchovatDo(new Date('2026-10-21T10:00:00Z'), 5)).toBe('2031-10-21');
    expect(uchovatDo(new Date('2028-02-29T10:00:00Z'), 5)).toBe('2033-02-28');
    const zaklad = { obec: { nazev: 'Obec X', kratky_nazev: 'X', casti: ['X'] } };
    expect(adresaPodatelny(obecZObjektu({ ...zaklad, podatelna: { email: 'pod@x.cz' } }))).toBe('pod@x.cz');
    expect(
      adresaPodatelny(
        obecZObjektu({ obec: { ...zaklad.obec, kontakt: { email: 'info@x.cz', epodatelna: 'ep@x.cz' } } }),
      ),
    ).toBe('ep@x.cz');
    expect(adresaPodatelny(obecZObjektu({ obec: { ...zaklad.obec, kontakt: { email: 'info@x.cz' } } }))).toBe(
      'info@x.cz',
    );
    expect(obecZObjektu(zaklad).podatelna.uchovani_let).toBe(5);
  });
});

describe('podatelna v aplikaci', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t.zavri());
  beforeEach(() => {
    for (const l of Object.values(t.app.limity)) l.reset();
  });

  function zIp(ip: string) {
    const p = new Prohlizec(t.base);
    p.hlavicky = { 'x-forwarded-for': ip };
    return p;
  }

  async function podej(p: Prohlizec, data: Record<string, string>) {
    const f = await p.get('/podatelna');
    return p.post('/podatelna', { _csrf: csrfZ(f.text), ...data });
  }

  it('formulář: pole s popisky, past na roboty skrytá, odkaz na zásady, funguje bez JS', async () => {
    const r = await new Prohlizec(t.base).get('/podatelna');
    expect(r.res.status).toBe(200);
    for (const id of [
      'jmeno',
      'ulice',
      'obec',
      'psc',
      'telefon',
      'email',
      'predmet',
      'text',
      'beru_na_vedomi',
    ])
      expect(r.text).toMatch(new RegExp(`for="${id}"[\\s\\S]*id="${id}"`));
    expect(r.text).toContain('class="past" aria-hidden="true"');
    expect(r.text).toContain('tabindex="-1"');
    expect(r.text).toContain('href="/ochrana-osobnich-udaju"');
    expect(r.text).toContain('method="post" action="/podatelna"');
    expect(r.text).not.toMatch(/<script[^>]*podatelna/);
  });

  it('podání se uloží s číslem, úřad dostane e-mail s Reply-To a podatel potvrzení', async () => {
    const pred = t.mail.odeslane.length;
    const r = await podej(zIp('203.0.113.50'), PLNE);
    expect(r.url).toMatch(/\/podatelna\/prijato$/);
    const rok = new Date().getFullYear();
    expect(r.text).toContain(`EP-${rok}-0001`);
    expect(r.text).toContain('následující úřední den');
    const p = await t.db.selectFrom('pod_podani').selectAll().executeTakeFirstOrThrow();
    expect(p.cislo).toBe(`EP-${rok}-0001`);
    expect(p.jmeno).toBe('Jan Testovací');
    expect(p.odeslano_uradu_at).not.toBeNull();
    expect(p.potvrzeni_at).not.toBeNull();
    expect(p.chyba_odeslani).toBe('');
    expect(p.uchovat_do.slice(0, 4)).toBe(String(Number(p.prijato_at.toISOString().slice(0, 4)) + 5));
    const nove = t.mail.odeslane.slice(pred);
    expect(nove).toHaveLength(2);
    const uradu = nove.find((m) => m.komu === 'obec@testov.cz')!;
    expect(uradu.replyTo).toBe('jan.test@example.cz');
    expect(uradu.predmet).toContain(`EP-${rok}-0001`);
    expect(uradu.text).toContain('žádám o vyjádření');
    expect(uradu.text).toContain('Testov 12, 463 44 Testov');
    const potvrzeni = nove.find((m) => m.komu === 'jan.test@example.cz')!;
    expect(potvrzeni.text).toContain(`EP-${rok}-0001`);
    expect(potvrzeni.text).toContain('následující úřední den');
    expect(potvrzeni.replyTo).toBe('obec@testov.cz');
    // stránka s poděkováním je jednorázová
    const znovu = await new Prohlizec(t.base).get('/podatelna/prijato');
    expect(znovu.url).toMatch(/\/podatelna$/);
  });

  it('bez e-mailu: jen e-mail úřadu, další číslo v řadě', async () => {
    const pred = t.mail.odeslane.length;
    const r = await podej(zIp('203.0.113.51'), { ...PLNE, email: '' });
    expect(r.text).toContain(`EP-${new Date().getFullYear()}-0002`);
    expect(r.text).toContain('poznamenejte');
    const nove = t.mail.odeslane.slice(pred);
    expect(nove.map((m) => m.komu)).toEqual(['obec@testov.cz']);
    expect(nove[0]!.replyTo).toBeUndefined();
  });

  it('chybný formulář: 400, chyby u polí, vyplněné hodnoty zůstanou, nic se neuloží', async () => {
    const pred = await t.db.selectFrom('pod_podani').select('id').execute();
    const r = await podej(zIp('203.0.113.52'), { ...PLNE, psc: '12', predmet: '', jmeno: '<b>Jan</b> X' });
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('role="alert"');
    expect(r.text).toContain('id="psc-chyba"');
    expect(r.text).toContain('aria-invalid="true"');
    expect(r.text).toContain('value="&lt;b&gt;Jan&lt;/b&gt; X"');
    expect(r.text).not.toContain('<b>Jan</b>');
    const po = await t.db.selectFrom('pod_podani').select('id').execute();
    expect(po.length).toBe(pred.length);
  });

  it('past na roboty: stejná odpověď, ale nic se neuloží ani neodešle', async () => {
    const predMail = t.mail.odeslane.length;
    const pred = await t.db.selectFrom('pod_podani').select('id').execute();
    const r = await podej(zIp('203.0.113.53'), { ...PLNE, web: 'http://spam.example' });
    expect(r.url).toMatch(/\/podatelna\/prijato$/);
    expect(r.text).toContain('Podání bylo odesláno');
    expect(t.mail.odeslane.length).toBe(predMail);
    expect((await t.db.selectFrom('pod_podani').select('id').execute()).length).toBe(pred.length);
  });

  it('bez CSRF tokenu se podání odmítne', async () => {
    const r = await zIp('203.0.113.54').post('/podatelna', PLNE);
    expect(r.res.status).toBe(403);
  });

  it('limit podle IP: šesté podání za 15 minut dostane 429', async () => {
    const p = zIp('203.0.113.55');
    for (let i = 0; i < 5; i++) {
      const r = await podej(p, { ...PLNE, email: '', predmet: `Limit ${i}` });
      expect(r.res.status).toBe(200);
    }
    const r = await podej(p, { ...PLNE, email: '' });
    expect(r.res.status).toBe(429);
    // jiná adresa podává dál
    expect((await podej(zIp('203.0.113.56'), { ...PLNE, email: '' })).res.status).toBe(200);
  });

  it('správa: jen správce obce; seznam, detail, vyřízení s poznámkou, audit', async () => {
    const web = await prihlasSRoli(t, '777555101', ['web']);
    expect((await web.get('/sprava/podatelna')).res.status).toBe(403);
    expect((await new Prohlizec(t.base).get('/sprava/podatelna', false)).res.status).toBe(302);

    const s = await prihlasSRoli(t, '777555102', ['spravce']);
    const prehled = await s.get('/sprava');
    expect(prehled.text).toContain('href="/sprava/podatelna"');
    const seznam = await s.get('/sprava/podatelna');
    expect(seznam.res.status).toBe(200);
    expect(seznam.text).toContain('Žádost o vyjádření');
    const p = await t.db
      .selectFrom('pod_podani')
      .select(['id', 'cislo'])
      .where('poradi', '=', 1)
      .executeTakeFirstOrThrow();
    const detail = await s.get(`/sprava/podatelna/${p.id}`);
    expect(detail.text).toContain('žádám o vyjádření');
    expect(detail.text).toContain('jan.test@example.cz');

    // jen poznámka: stav se nemění
    await s.post(`/sprava/podatelna/${p.id}`, {
      _csrf: csrfZ(detail.text),
      akce: 'poznamka',
      poznamka: 'čj. 1/2026',
    });
    let radek = await t.db
      .selectFrom('pod_podani')
      .selectAll()
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(radek.poznamka).toBe('čj. 1/2026');
    expect(radek.vyrizeno_at).toBeNull();

    const d2 = await s.get(`/sprava/podatelna/${p.id}`);
    const po = await s.post(`/sprava/podatelna/${p.id}`, {
      _csrf: csrfZ(d2.text),
      akce: 'vyrizeno',
      poznamka: 'čj. 1/2026',
    });
    expect(po.url).toMatch(/\/sprava\/podatelna$/);
    expect(po.text).not.toContain(`>${p.cislo}<`); // filtr nevyřízených
    radek = await t.db.selectFrom('pod_podani').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(radek.vyrizeno_at).not.toBeNull();
    expect(radek.vyridil_id).not.toBeNull();
    const vse = await s.get('/sprava/podatelna?vse=1');
    expect(vse.text).toContain(`>${p.cislo}<`);

    const audit = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', 'like', 'podatelna.%')
      .execute();
    expect(audit.map((a) => a.akce)).toEqual(
      expect.arrayContaining(['podatelna.prijato', 'podatelna.poznamka', 'podatelna.vyrizeno']),
    );

    // neznámá akce a neexistující podání
    const d3 = await s.get(`/sprava/podatelna/${p.id}`);
    expect(
      (await s.post(`/sprava/podatelna/${p.id}`, { _csrf: csrfZ(d3.text), akce: 'smazat' })).res.status,
    ).toBe(400);
    expect((await s.get('/sprava/podatelna/00000000-0000-0000-0000-000000000000')).res.status).toBe(404);
  });

  it('selhání pošty: podání zůstane uložené a správa vidí chybu', async () => {
    const puvodni = t.mail.posli.bind(t.mail);
    t.mail.posli = async () => {
      throw new Error('SMTP nedostupné');
    };
    try {
      const r = await podej(zIp('203.0.113.57'), { ...PLNE, predmet: 'Pošta nejde' });
      expect(r.url).toMatch(/\/podatelna\/prijato$/);
    } finally {
      t.mail.posli = puvodni;
    }
    const p = await t.db
      .selectFrom('pod_podani')
      .selectAll()
      .where('predmet', '=', 'Pošta nejde')
      .executeTakeFirstOrThrow();
    expect(p.odeslano_uradu_at).toBeNull();
    expect(p.chyba_odeslani).toContain('e-mail úřadu');
  });

  it('mapa stránek a zásady ochrany osobních údajů zmiňují podatelnu', async () => {
    const mapa = await new Prohlizec(t.base).get('/mapa-stranek');
    expect(mapa.text).toContain('href="/podatelna"');
    const gdpr = await new Prohlizec(t.base).get('/ochrana-osobnich-udaju');
    expect(gdpr.text).toContain('Elektronická podatelna');
  });
});
