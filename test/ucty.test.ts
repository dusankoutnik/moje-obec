import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  csrfZ,
  devKodZ,
  prihlasSRoli,
  prihlasTelefonem,
  Prohlizec,
  spustTestApp,
  type TestApp,
} from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
// všechny požadavky jdou z jedné IP — limity podle IP mezi testy nulovat
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

describe('základ', () => {
  it('healthz hlásí ok', async () => {
    const r = await fetch(`${t.base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ stav: 'ok' });
  });
  it('úvod, povinné stránky a 404 česky', async () => {
    const p = new Prohlizec(t.base);
    const uvod = await p.get('/');
    expect(uvod.res.status).toBe(200);
    expect(uvod.text).toContain('Prohlášení o přístupnosti');
    expect(uvod.text).toContain('Ochrana osobních údajů');
    expect(uvod.text).toContain('lang="cs"');
    expect((await p.get('/prohlaseni-o-pristupnosti')).res.status).toBe(200);
    const nic = await p.get('/tohle-neexistuje');
    expect(nic.res.status).toBe(404);
    expect(nic.text).toContain('Stránka nenalezena');
  });
  it('POST bez CSRF tokenu je odmítnut', async () => {
    const r = await fetch(`${t.base}/odhlaseni`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(r.status).toBe(403);
  });
});

describe('přihlášení telefonem', () => {
  it('nový občan: SMS kód → GDPR souhlas → účet existuje', async () => {
    const p = new Prohlizec(t.base);
    const po = await prihlasTelefonem(p, '777 100 100');
    expect(po.url).toContain('/ucet');
    expect(po.text).toContain('Můj účet');
    expect(t.sms.odeslane.at(-1)?.telefon).toBe('+420777100100');
    expect(t.sms.odeslane.at(-1)?.text).toMatch(/^TESTOV: Prihlasovaci kod: \d{6}/);
    const u = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('telefon', '=', '+420777100100')
      .executeTakeFirstOrThrow();
    expect(u.gdpr_souhlas_at).not.toBeNull();
    expect(u.telefon_overen_at).not.toBeNull();
    expect(u.role).toEqual([]);
    const audit = await t.db.selectFrom('audit_log').select('akce').where('uzivatel_id', '=', u.id).execute();
    expect(audit.map((a) => a.akce)).toEqual(
      expect.arrayContaining(['ucet.zalozen', 'prihlaseni', 'ucet.gdpr_souhlas']),
    );
  });
  it('špatný kód neprojde, správný ano; druhé přihlášení bez souhlasu', async () => {
    const p = new Prohlizec(t.base);
    const inter = await p.get('/prihlaseni');
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    const kodStranka = await p.post(`/oidc/interaction/${uid}/telefon`, {
      _csrf: csrfZ(inter.text),
      telefon: '777100100',
    });
    const spatne = await p.post(`/oidc/interaction/${uid}/kod`, {
      _csrf: csrfZ(kodStranka.text),
      telefon: '+420777100100',
      kod: '000000',
    });
    expect(spatne.text).toContain('Kód nesouhlasí');
    const ok = await p.post(`/oidc/interaction/${uid}/kod`, {
      _csrf: csrfZ(spatne.text),
      telefon: '+420777100100',
      kod: devKodZ(kodStranka.text),
    });
    expect(ok.url).toContain('/ucet');
  });
  it('neplatný telefon vrátí formulář s chybou', async () => {
    const p = new Prohlizec(t.base);
    const inter = await p.get('/prihlaseni');
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    const r = await p.post(`/oidc/interaction/${uid}/telefon`, { _csrf: csrfZ(inter.text), telefon: '12' });
    expect(r.text).toContain('nevypadá jako telefonní číslo');
  });
  it('limit 3 kódy za hodinu', async () => {
    const p = new Prohlizec(t.base);
    const inter = await p.get('/prihlaseni');
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    let posledni = inter.text;
    for (let i = 0; i < 3; i++)
      posledni = (
        await p.post(`/oidc/interaction/${uid}/telefon`, { _csrf: csrfZ(posledni), telefon: '777100200' })
      ).text;
    const r = await p.post(`/oidc/interaction/${uid}/telefon`, {
      _csrf: csrfZ(posledni),
      telefon: '777100200',
    });
    expect(r.text).toContain('Příliš mnoho pokusů');
  });
});

describe('účet a heslo', () => {
  it('uloží profil, přes ověření nastaví e-mail a heslo a přihlásí se heslem', async () => {
    const p = new Prohlizec(t.base);
    const ucet = await prihlasTelefonem(p, '777100300');
    const po = await p.post('/ucet', {
      _csrf: csrfZ(ucet.text),
      jmeno: 'Jana',
      prijmeni: 'Nováková',
      prezdivka: 'Jana',
      cast_obce: 'Dolní Testov',
    });
    expect(po.text).toContain('Uloženo');
    const u = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('telefon', '=', '+420777100300')
      .executeTakeFirstOrThrow();
    expect(u).toMatchObject({ jmeno: 'Jana', prijmeni: 'Nováková', cast_obce: 'Dolní Testov' });

    const overeni = await p.get('/ucet/email');
    expect(overeni.url).toContain('/ucet/overeni');
    const poslano = await p.post('/ucet/overeni/sms', { _csrf: csrfZ(overeni.text), dalsi: '/ucet/email' });
    const form = await p.post('/ucet/overeni/kod', {
      _csrf: csrfZ(poslano.text),
      dalsi: '/ucet/email',
      kod: devKodZ(poslano.text),
    });
    const kodStrana = await p.post('/ucet/email', { _csrf: csrfZ(form.text), email: 'Jana@Example.cz' });
    const kod = /kód z e-mailu je (\d{6})/.exec(kodStrana.text)![1]!;
    const potvrzeno = await p.post('/ucet/email/potvrdit', { _csrf: csrfZ(kodStrana.text), kod });
    expect(potvrzeno.text).toContain('jana@example.cz');
    const hesloForm = await p.get('/ucet/heslo');
    const kratke = await p.post('/ucet/heslo', {
      _csrf: csrfZ(hesloForm.text),
      heslo: 'kratke',
      heslo2: 'kratke',
    });
    expect(kratke.text).toContain('aspoň 10 znaků');
    const heslo = await p.post('/ucet/heslo', {
      _csrf: csrfZ(kratke.text),
      heslo: 'velmi-tajne-heslo',
      heslo2: 'velmi-tajne-heslo',
    });
    expect(heslo.text).toContain('heslo je nastavené');

    // odhlášení (RP-initiated logout přes provider) a přihlášení heslem
    const odhl = await p.post('/odhlaseni', { _csrf: csrfZ(heslo.text) });
    // provider se zeptá na potvrzení (stránka „Odhlášení“), nebo — po odhlášení ostatních sezení — rovnou odešle formulář
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(odhl.text)![1]!;
    await p.post('/oidc/session/end/confirm', { xsrf, logout: 'yes' });
    const ucet2 = await p.get('/ucet');
    expect(ucet2.url).toContain('/oidc/interaction/');
    const uid = ucet2.url.split('/oidc/interaction/')[1]!;
    const hesloStranka = await p.get(`/oidc/interaction/${uid}/heslo`);
    const spatne = await p.post(`/oidc/interaction/${uid}/heslo`, {
      _csrf: csrfZ(hesloStranka.text),
      email: 'jana@example.cz',
      heslo: 'spatne-heslo-xx',
    });
    expect(spatne.text).toContain('nesouhlasí');
    const ok = await p.post(`/oidc/interaction/${uid}/heslo`, {
      _csrf: csrfZ(spatne.text),
      email: 'jana@example.cz',
      heslo: 'velmi-tajne-heslo',
    });
    expect(ok.url).toContain('/ucet');
    expect(ok.text).toContain('Jana');
  });
});

describe('role a správa', () => {
  it('občan nemá přístup do správy; admin ano; role a blokace se zapisují', async () => {
    const obcan = new Prohlizec(t.base);
    await prihlasTelefonem(obcan, '777100400');
    const zakaz = await obcan.get('/sprava');
    expect(zakaz.res.status).toBe(403);

    const adminTel = '+420777100500';
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: adminTel,
        email: null,
        heslo_hash: null,
        role: ['admin'],
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const admin = new Prohlizec(t.base);
    await prihlasTelefonem(admin, adminTel);
    const sprava = await admin.get('/sprava');
    expect(sprava.res.status).toBe(200);
    expect(sprava.text).toContain('Uživatelé');

    const obcanRadek = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777100400')
      .executeTakeFirstOrThrow();
    const detail = await admin.get(`/sprava/uzivatele/${obcanRadek.id}`);
    const poRoli = await admin.post(`/sprava/uzivatele/${obcanRadek.id}`, {
      _csrf: csrfZ(detail.text),
      akce: 'role',
      role: ['redaktor', 'nesmysl'],
    });
    expect(poRoli.text).toContain('Role uloženy');
    const u = await t.db
      .selectFrom('uzivatele')
      .select('role')
      .where('id', '=', obcanRadek.id)
      .executeTakeFirstOrThrow();
    expect(u.role).toEqual(['redaktor']);
    // redaktor teď vidí správu (infokanál), ale ne uživatele
    expect((await obcan.get('/sprava')).res.status).toBe(200);
    expect((await obcan.get('/sprava/uzivatele')).res.status).toBe(403);

    const poBlokaci = await admin.post(`/sprava/uzivatele/${obcanRadek.id}`, {
      _csrf: csrfZ(poRoli.text),
      akce: 'blokovat',
    });
    expect(poBlokaci.text).toContain('zablokován');
    // zablokovaný je okamžitě odhlášen
    const poOdhlaseni = await obcan.get('/ucet');
    expect(poOdhlaseni.url).toContain('/oidc/interaction/');
    // admin si sám sobě role nemění
    const self = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', adminTel)
      .executeTakeFirstOrThrow();
    const selfDetail = await admin.get(`/sprava/uzivatele/${self.id}`);
    const selfRole = await admin.post(`/sprava/uzivatele/${self.id}`, {
      _csrf: csrfZ(selfDetail.text),
      akce: 'role',
      role: [],
    });
    expect(selfRole.text).toContain('Vlastní role si měnit nemůžete');
    const audit = await admin.get('/sprava/audit');
    expect(audit.text).toContain('sprava.role');
    expect(audit.text).toContain('sprava.blokace');
  });

  it('role pro web: redaktor webu, úřední deska a hlášení jsou zvlášť; správce smí vše obsahové', async () => {
    const { maRoli } = await import('../src/moduly/ucty/sluzba.js');
    const u = (role: string[]) => ({ role }) as unknown as Parameters<typeof maRoli>[0];
    expect(maRoli(u(['web']), 'web')).toBe(true);
    expect(maRoli(u(['web']), 'deska')).toBe(false);
    expect(maRoli(u(['web']), 'redaktor')).toBe(false);
    expect(maRoli(u(['deska']), 'web')).toBe(false);
    expect(maRoli(u(['redaktor']), 'web')).toBe(false);
    expect(maRoli(u(['spravce']), 'web')).toBe(true);
    expect(maRoli(u(['spravce']), 'deska')).toBe(true);
    expect(maRoli(u(['spravce']), 'redaktor')).toBe(true);
    expect(maRoli(u(['spravce']), 'vstupne')).toBe(false);
    expect(maRoli(u(['admin']), 'vstupne')).toBe(true);
    const hl = await prihlasSRoli(t, '777600001', ['redaktor']);
    expect((await hl.get('/sprava/web')).res.status).toBe(403);
    expect((await hl.get('/sprava/deska')).res.status).toBe(403);
    expect((await hl.get('/infokanal/sprava')).res.status).toBe(200);
    const sprava = await hl.get('/sprava');
    expect(sprava.text).not.toContain('href="/sprava/web"');
  });
});
