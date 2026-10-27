// Role „provozovatel“ (v UI Superadmin): práva nad adminem, chráněný účet, vzhled webu (admin i on), stránka Administrace → Role.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ROLE, type Role } from '../src/db/types.js';
import { maskujTelefon } from '../src/lib/kontakty.js';
import { DEFINICE_ROLI, efektivniRole, roleProAplikace, roleSPravem } from '../src/moduly/ucty/role.js';
import { maRoli, profilUzivatele } from '../src/moduly/ucty/sluzba.js';
import { csrfZ, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const u = (role: Role[]) => ({ role }) as unknown as Parameters<typeof maRoli>[0];

async function ucet(telefon: string, role: Role[], jmeno = '', prijmeni = '') {
  const r = await t.db
    .insertInto('uzivatele')
    .values({ telefon, email: null, heslo_hash: null, role, jmeno, prijmeni, gdpr_souhlas_at: new Date() })
    .onConflict((oc) => oc.column('telefon').doUpdateSet({ role, blokovan_at: null }))
    .returningAll()
    .executeTakeFirstOrThrow();
  return r;
}
async function role(id: string) {
  return await t.db
    .selectFrom('uzivatele')
    .select(['role', 'blokovan_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

describe('definice rolí', () => {
  it('každá role z DB má právě jednu definici a naopak', () => {
    expect(DEFINICE_ROLI.map((d) => d.id).sort()).toEqual([...ROLE].sort());
    for (const d of DEFINICE_ROLI) {
      expect(d.nazev.length).toBeGreaterThan(0);
      expect(d.popis.length).toBeGreaterThan(0);
      expect(d.opravneni.length).toBeGreaterThan(0);
    }
  });
  it('provozovatel ⊃ admin ⊃ vše ostatní; admin nemá provozovatele; správce ⊃ web, deska, redaktor', () => {
    expect([...efektivniRole(['provozovatel'])].sort()).toEqual([...ROLE].sort());
    expect(efektivniRole(['admin']).has('provozovatel')).toBe(false);
    expect(efektivniRole(['admin']).size).toBe(ROLE.length - 1);
    expect(maRoli(u(['provozovatel']), 'admin')).toBe(true);
    expect(maRoli(u(['provozovatel']), 'vstupne')).toBe(true);
    expect(maRoli(u(['admin']), 'provozovatel')).toBe(false);
    expect(maRoli(u(['admin']), 'spravce', 'provozovatel')).toBe(true);
    expect(maRoli(u(['spravce']), 'web')).toBe(true);
    expect(maRoli(u(['spravce']), 'kviz')).toBe(false);
    expect(roleSPravem('web')).toEqual(expect.arrayContaining(['spravce', 'admin', 'provozovatel']));
    expect(roleSPravem('provozovatel')).toEqual([]);
  });
  it('aplikacím se provozovatel hlásí i jako admin', () => {
    expect(roleProAplikace(['provozovatel'])).toEqual(['provozovatel', 'admin']);
    expect(roleProAplikace(['web'])).toEqual(['web']);
    const p = profilUzivatele({
      id: 'x',
      cislo: 1,
      jmeno: '',
      prijmeni: '',
      prezdivka: '',
      telefon: '+420777000000',
      role: ['provozovatel'],
      vytvoren_at: new Date(),
    } as never);
    expect(p.role).toContain('admin');
  });
  it('maskovaný telefon', () => {
    expect(maskujTelefon('+420777123456')).toBe('+420 777 *** 456');
  });
});

describe('chráněný účet provozovatele', () => {
  it('admin ho nesmí blokovat, měnit mu role ani přidělit roli provozovatel; provozovatel ano', async () => {
    const buhUcet = await ucet('+420777900001', ['provozovatel'], 'Bůh', 'Testovací');
    const obcan = await ucet('+420777900002', [], 'Občan', 'Testovací');
    const admin = await prihlasSRoli(t, '777900003', ['admin']);

    // detail chráněného účtu: bez formuláře rolí a bez blokace
    const detail = await admin.get(`/sprava/uzivatele/${buhUcet.id}`);
    expect(detail.res.status).toBe(200);
    expect(detail.text).toContain('Chráněný účet');
    expect(detail.text).not.toContain('value="blokovat"');
    expect(detail.text).not.toContain('name="role"');

    const csrf = csrfZ(detail.text);
    const blok = await admin.post(`/sprava/uzivatele/${buhUcet.id}`, { _csrf: csrf, akce: 'blokovat' });
    expect(blok.text).toContain('blokovat nemůžete');
    expect((await role(buhUcet.id)).blokovan_at).toBeNull();

    const r1 = await admin.post(`/sprava/uzivatele/${buhUcet.id}`, { _csrf: csrf, akce: 'role', role: [] });
    expect(r1.text).toContain('smí měnit jen Superadmin');
    expect((await role(buhUcet.id)).role).toEqual(['provozovatel']);

    const odemknout = await admin.post(`/sprava/uzivatele/${buhUcet.id}`, { _csrf: csrf, akce: 'odemknout' });
    expect(odemknout.text).toContain('smí měnit jen Superadmin');

    // admin nesmí přidělit roli provozovatel běžnému účtu (checkbox je zamčený, server to hlídá taky)
    const dObcan = await admin.get(`/sprava/uzivatele/${obcan.id}`);
    expect(dObcan.text).toMatch(/value="provozovatel"[^>]*disabled/);
    const r2 = await admin.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrfZ(dObcan.text),
      akce: 'role',
      role: ['provozovatel', 'web'],
    });
    expect(r2.text).toContain('smí přidělit nebo odebrat jen Superadmin');
    expect((await role(obcan.id)).role).toEqual([]);
    // běžnou roli admin dál přidělí
    const r3 = await admin.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrfZ(dObcan.text),
      akce: 'role',
      role: ['web'],
    });
    expect(r3.text).toContain('Role uloženy');

    // provozovatel přidělí roli provozovatel i zablokuje/odblokuje jiného provozovatele
    const buh = await prihlasSRoli(t, '777900001', ['provozovatel']);
    const d2 = await buh.get(`/sprava/uzivatele/${obcan.id}`);
    const r4 = await buh.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrfZ(d2.text),
      akce: 'role',
      role: ['provozovatel'],
    });
    expect(r4.text).toContain('Role uloženy');
    expect((await role(obcan.id)).role).toEqual(['provozovatel']);
    const audit = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'sprava.role')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ cil: obcan.id, role: ['provozovatel'], puvodne: ['web'] });
    const b = await buh.post(`/sprava/uzivatele/${obcan.id}`, { _csrf: csrfZ(d2.text), akce: 'blokovat' });
    expect(b.text).toContain('zablokován');
    await buh.post(`/sprava/uzivatele/${obcan.id}`, { _csrf: csrfZ(d2.text), akce: 'odblokovat' });
    expect((await role(obcan.id)).blokovan_at).toBeNull();
    // úklid: druhý provozovatel pryč (pořád zůstává jeden)
    await t.db.updateTable('uzivatele').set({ role: [] }).where('id', '=', obcan.id).execute();
  });

  it('poslední provozovatel si roli neodebere; když je jiný, může', async () => {
    await t.db
      .updateTable('uzivatele')
      .set({ role: [] })
      .where('telefon', 'not in', ['+420777900001'])
      .where(sql<boolean>`'provozovatel' = ANY(role)`)
      .execute();
    const buh = await prihlasSRoli(t, '777900001', ['provozovatel']);
    const ja = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('telefon', '=', '+420777900001')
      .executeTakeFirstOrThrow();
    const d = await buh.get(`/sprava/uzivatele/${ja.id}`);
    expect(d.text).toContain('name="role"');
    const r = await buh.post(`/sprava/uzivatele/${ja.id}`, {
      _csrf: csrfZ(d.text),
      akce: 'role',
      role: ['web'],
    });
    expect(r.text).toContain('aspoň jednoho Superadmina');
    expect((await role(ja.id)).role).toEqual(['provozovatel']);
    // přes stránku Role totéž
    const s = await buh.get('/sprava/role');
    const r2 = await buh.post('/sprava/role/provozovatel/odebrat', { _csrf: csrfZ(s.text), uzivatel: ja.id });
    expect(r2.text).toContain('aspoň jednoho Superadmina');
    // vlastní běžnou roli si provozovatel přidat smí
    const r3 = await buh.post(`/sprava/uzivatele/${ja.id}`, {
      _csrf: csrfZ(d.text),
      akce: 'role',
      role: ['provozovatel', 'web'],
    });
    expect(r3.text).toContain('Role uloženy');
    // s druhým provozovatelem odebrat jde
    const druhy = await ucet('+420777900004', ['provozovatel'], 'Druhý', 'Bůh');
    const r4 = await buh.post('/sprava/role/provozovatel/odebrat', { _csrf: csrfZ(s.text), uzivatel: ja.id });
    expect(r4.text).toContain('odebrána');
    expect((await role(ja.id)).role).toEqual(['web']);
    // vrátit zpět (dělá to druhý provozovatel)
    await t.db
      .updateTable('uzivatele')
      .set({ role: ['provozovatel'] })
      .where('id', '=', ja.id)
      .execute();
    await t.db.updateTable('uzivatele').set({ role: [] }).where('id', '=', druhy.id).execute();
  });

  it('správce nesmí posoudit rezidenta, doplnit jméno ani schválit telefon chráněného účtu', async () => {
    const chraneny = await ucet('+420777900005', ['provozovatel']);
    const spr = await prihlasSRoli(t, '777900006', ['spravce']);
    const s = await spr.get('/sprava');
    const csrf = csrfZ(s.text);
    const r = await spr.post(`/sprava/schvalovani/rezident/${chraneny.id}`, { _csrf: csrf, rezident: '1' });
    expect(r.text).toContain('smí měnit jen Superadmin');
    const j = await spr.post(`/sprava/schvalovani/jmeno/${chraneny.id}`, {
      _csrf: csrf,
      jmeno: 'Cizí',
      prijmeni: 'Jméno',
    });
    expect(j.text).toContain('smí měnit jen Superadmin');
    const po = await t.db
      .selectFrom('uzivatele')
      .select(['rezident', 'jmeno'])
      .where('id', '=', chraneny.id)
      .executeTakeFirstOrThrow();
    expect(po).toMatchObject({ rezident: false, jmeno: '' });

    const z = await t.db
      .insertInto('uzivatele_zmeny_telefonu')
      .values({ uzivatel_id: chraneny.id, telefon_stary: chraneny.telefon, telefon_novy: '+420777900099' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const tel = await spr.post(`/sprava/ucty/zmeny-telefonu/${z.id}`, { _csrf: csrf, akce: 'schvalit' });
    expect(tel.text).toContain('smí měnit jen Superadmin');
    const potom = await t.db
      .selectFrom('uzivatele')
      .select('telefon')
      .where('id', '=', chraneny.id)
      .executeTakeFirstOrThrow();
    expect(potom.telefon).toBe('+420777900005');
    await t.db.updateTable('uzivatele').set({ role: [] }).where('id', '=', chraneny.id).execute();
  });
});

describe('vzhled webu pro admina a provozovatele', () => {
  it('správce: 403 na všech routách vzhledu a bez dlaždice; admin a provozovatel ano', async () => {
    const spr = await prihlasSRoli(t, '777900006', ['spravce']);
    expect((await spr.get('/sprava/web/vzhled')).res.status).toBe(403);
    const prehled = await spr.get('/sprava');
    expect(prehled.text).not.toContain('href="/sprava/web/vzhled"');
    expect((await spr.get('/sprava/web')).text).not.toContain('href="/sprava/web/vzhled"');
    const csrf = csrfZ(prehled.text);
    for (const cesta of [
      '/sprava/web/vzhled',
      '/sprava/web/vzhled/nahled-pouzit',
      '/sprava/web/vzhled/nahled-zrusit',
      '/sprava/web/vzhled/zpet',
    ])
      expect((await spr.post(cesta, { _csrf: csrf, akce: 'ulozit' })).res.status).toBe(403);
    const admin = await prihlasSRoli(t, '777900003', ['admin']);
    const buh = await prihlasSRoli(t, '777900031', ['provozovatel']);
    for (const p of [admin, buh]) {
      expect((await p.get('/sprava/web/vzhled')).res.status).toBe(200);
      expect((await p.get('/sprava')).text).toContain('href="/sprava/web/vzhled"');
      expect((await p.get('/sprava/web')).text).toContain('href="/sprava/web/vzhled"');
    }
  });
});

describe('stránka Administrace → Systém → Role', () => {
  it('správce a admin čtou (bez formulářů), redaktor 403, občan na přihlášení', async () => {
    await ucet('+420777900010', ['web'], 'Věra', 'Redaktorová');
    const spr = await prihlasSRoli(t, '777900006', ['spravce']);
    const admin = await prihlasSRoli(t, '777900003', ['admin']);
    for (const p of [spr, admin]) {
      const s = await p.get('/sprava/role');
      expect(s.res.status).toBe(200);
      expect(s.text).toContain('Superadmin');
      expect(s.text).toContain('Redaktor webu');
      expect(s.text).toContain('Redaktorová');
      // telefon maskovaný, nikde celý
      expect(s.text).toContain('+420 777 *** 010');
      expect(s.text).not.toContain('777 900 010');
      expect(s.text).toContain('jen ke čtení');
      expect(s.text).not.toContain('/sprava/role/web/pridat');
      expect(s.text).not.toContain('/odebrat');
      expect((await p.get('/sprava')).text).toContain('href="/sprava/role"');
      // POST jen provozovatel
      const r = await p.post('/sprava/role/web/pridat', {
        _csrf: csrfZ(s.text),
        uzivatel: '00000000-0000-0000-0000-000000000000',
      });
      expect(r.res.status).toBe(403);
    }
    const red = await prihlasSRoli(t, '777900011', ['web']);
    expect((await red.get('/sprava/role')).res.status).toBe(403);
    const anonym = new Prohlizec(t.base);
    expect((await anonym.get('/sprava/role', false)).res.status).toBe(302);
  });

  it('provozovatel najde účet, přidá ho do role a odebere; zapíše se audit; bez CSRF 403', async () => {
    const cil = await ucet('+420777900020', [], 'Karel', 'Hledaný');
    const buh = await prihlasSRoli(t, '777900032', ['provozovatel']);
    const s = await buh.get('/sprava/role?pridat=deska&q=Hledan');
    expect(s.res.status).toBe(200);
    expect(s.text).toContain('Karel Hledaný');
    expect(s.text).toContain('action="/sprava/role/deska/pridat"');

    // bez CSRF tokenu odmítnuto
    const bez = await fetch(`${t.base}/sprava/role/deska/pridat`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `uzivatel=${cil.id}`,
    });
    expect(bez.status).toBe(403);
    expect((await role(cil.id)).role).toEqual([]);

    const p = await buh.post('/sprava/role/deska/pridat', { _csrf: csrfZ(s.text), uzivatel: cil.id });
    expect(p.text).toContain('Role „Úřední deska“ přidána: Karel Hledaný');
    expect((await role(cil.id)).role).toEqual(['deska']);
    // opakované přidání = beze změny
    const znovu = await buh.post('/sprava/role/deska/pridat', { _csrf: csrfZ(s.text), uzivatel: cil.id });
    expect(znovu.text).toContain('Beze změny');
    // člen je vidět v seznamu s formulářem odebrání
    const po = await buh.get('/sprava/role');
    expect(po.text).toContain('action="/sprava/role/deska/odebrat"');
    const o = await buh.post('/sprava/role/deska/odebrat', { _csrf: csrfZ(po.text), uzivatel: cil.id });
    expect(o.text).toContain('odebrána');
    expect((await role(cil.id)).role).toEqual([]);

    const zaznamy = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'sprava.role')
      .orderBy('id')
      .execute();
    const moje = zaznamy.filter((z) => (z.detail as { cil?: string } | null)?.cil === cil.id);
    expect(moje.map((z) => z.detail)).toEqual([
      expect.objectContaining({ zdroj: 'stranka-role', pridano: ['deska'], role: ['deska'] }),
      expect.objectContaining({ zdroj: 'stranka-role', odebrano: ['deska'], role: [] }),
    ]);

    // neznámá role / akce = 404
    expect(
      (await buh.post('/sprava/role/nesmysl/pridat', { _csrf: csrfZ(po.text), uzivatel: cil.id })).res.status,
    ).toBe(404);
  });
});
