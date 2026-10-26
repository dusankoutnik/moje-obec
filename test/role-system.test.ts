// Stránka Role a Systém (26. 10. 2026): matice oprávnění proti skutečné ochraně rout, historie změn rolí, poslední
// aktivita a spící účty, e-mail při udělení silné role, přihlášená zařízení s odhlášením na dálku, stav systému
// a dočasné role.
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ROLE, type Role } from '../src/db/types.js';
import { datumPraha, pridejDny } from '../src/lib/datum.js';
import { bezAdres } from '../src/lib/mail.js';
import { zkratProhlizec } from '../src/lib/prohlizec.js';
import { jeSpici, rozdilZDetailu } from '../src/moduly/ucty/role-historie.js';
import { platiDoZDatumu, vyprsRole } from '../src/moduly/ucty/role-platnost.js';
import { OBLASTI_SPRAVY, roleSmiOblast } from '../src/moduly/ucty/role.js';
import { posledniZaloha } from '../src/moduly/ucty/sprava-system.js';
import { csrfZ, prihlasSRoli, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

async function ucet(telefon: string, role: Role[], extra: Record<string, unknown> = {}) {
  return t.db
    .insertInto('uzivatele')
    .values({
      telefon,
      email: null,
      heslo_hash: null,
      role,
      gdpr_souhlas_at: new Date(),
      ...extra,
    } as never)
    .onConflict((oc) => oc.column('telefon').doUpdateSet({ role, blokovan_at: null }))
    .returningAll()
    .executeTakeFirstOrThrow();
}
const idUctu = async (telefon: string) =>
  (await t.db.selectFrom('uzivatele').select('id').where('telefon', '=', telefon).executeTakeFirstOrThrow())
    .id;
const roleUctu = async (id: string) =>
  (await t.db.selectFrom('uzivatele').select('role').where('id', '=', id).executeTakeFirstOrThrow()).role;
const zitra = () => pridejDny(datumPraha(new Date()), 1);

describe('matice oprávnění = skutečná ochrana rout', () => {
  it('každá oblast s cestou pustí přesně role z matice (s odvozenými právy) a ostatním vrátí 403', async () => {
    const prohlizece = new Map<Role, Prohlizec>();
    let i = 0;
    for (const r of ROLE) {
      prohlizece.set(r, await prihlasSRoli(t, `7779100${String(i++).padStart(2, '0')}`, [r]));
      for (const l of Object.values(t.app.limity)) l.reset(); // jedenáct přihlášení z jedné IP
    }
    const obcan = await prihlasSRoli(t, '777910099', []);
    const chyby: string[] = [];
    for (const o of OBLASTI_SPRAVY) {
      if (!o.cesta) continue;
      for (const r of ROLE) {
        const { res } = await prohlizece.get(r)!.get(o.cesta);
        const smi = roleSmiOblast(r, o);
        if (smi !== (res.status !== 403) || (smi && res.status >= 400))
          chyby.push(`${o.cesta} × ${r}: matice ${smi ? 'smí' : 'nesmí'}, server ${res.status}`);
      }
      expect((await obcan.get(o.cesta)).res.status, `${o.cesta} × občan`).toBe(403);
    }
    expect(chyby).toEqual([]);
  });

  it('stránka Role ukazuje matici s oblastmi', async () => {
    const spr = await prihlasSRoli(t, '777910003', ['spravce']);
    const s = await spr.get('/sprava/role');
    expect(s.text).toContain('Matice oprávnění');
    expect(s.text).toContain('Stav systému');
    expect(s.text).toMatch(/<th scope="row">Vzhled webu<\/th>/);
  });
});

describe('Admin vs. Superadmin (přejmenování 26. 10. 2026)', () => {
  it('názvy rolí v UI; Admin nesmí přidělit ani odebrat roli Admin, ostatní role ano; Superadmin smí', async () => {
    const admin = await prihlasSRoli(t, '777919001', ['admin']);
    const obcan = await ucet('+420777919002', []);
    const jinyAdmin = await ucet('+420777919003', ['admin']);
    const d = await admin.get(`/sprava/uzivatele/${obcan.id}`);
    expect(d.text).toContain('Superadmin');
    expect(d.text).toContain('Vstupenkář');
    expect(d.text).not.toContain('Bůh');
    expect(d.text).toMatch(/value="admin"[^>]*disabled/);
    const csrf = csrfZ(d.text);
    const r1 = await admin.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['admin'],
    });
    expect(r1.text).toContain('Role Admin a Superadmin smí přidělit nebo odebrat jen Superadmin');
    expect(await roleUctu(obcan.id)).toEqual([]);
    const r2 = await admin.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['web'],
    });
    expect(r2.text).toContain('Role uloženy');
    // jinému Adminovi smí přidat běžnou roli (zamčená role admin jde formulářem jako skryté pole), odebrat admina ne
    const dj = await admin.get(`/sprava/uzivatele/${jinyAdmin.id}`);
    expect(dj.text).toContain('<input type="hidden" name="role" value="admin">');
    const r3 = await admin.post(`/sprava/uzivatele/${jinyAdmin.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['admin', 'kviz'],
    });
    expect(r3.text).toContain('Role uloženy');
    expect((await roleUctu(jinyAdmin.id)).sort()).toEqual(['admin', 'kviz']);
    const r4 = await admin.post(`/sprava/uzivatele/${jinyAdmin.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['kviz'],
    });
    expect(r4.text).toContain('jen Superadmin');
    expect((await roleUctu(jinyAdmin.id)).sort()).toEqual(['admin', 'kviz']);
    // Superadmin smí
    const buh = await prihlasSRoli(t, '777919004', ['provozovatel']);
    const db = await buh.get(`/sprava/uzivatele/${obcan.id}`);
    const r5 = await buh.post(`/sprava/uzivatele/${obcan.id}`, {
      _csrf: csrfZ(db.text),
      akce: 'role',
      role: ['admin'],
    });
    expect(r5.text).toContain('Role uloženy');
    expect(await roleUctu(obcan.id)).toEqual(['admin']);
    await t.db
      .updateTable('uzivatele')
      .set({ role: [] })
      .where('id', 'in', [obcan.id, jinyAdmin.id])
      .execute();
  });
});

describe('historie změn rolí', () => {
  it('přidání na stránce Role i změna v detailu účtu se zapíší s rozdílem; filtr podle účtu', async () => {
    const buh = await prihlasSRoli(t, '777911001', ['provozovatel']);
    const cil = await ucet('+420777911002', [], { jmeno: 'Hana', prijmeni: 'Historická' });
    const s = await buh.get('/sprava/role');
    const r = await buh.post('/sprava/role/web/pridat', { _csrf: csrfZ(s.text), uzivatel: cil.id });
    expect(r.text).toContain('přidána');
    const d = await buh.get(`/sprava/uzivatele/${cil.id}`);
    await buh.post(`/sprava/uzivatele/${cil.id}`, { _csrf: csrfZ(d.text), akce: 'role', role: ['deska'] });
    expect(await roleUctu(cil.id)).toEqual(['deska']);

    const audit = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'sprava.role')
      .where(sql<boolean>`detail->>'cil' = ${cil.id}`)
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.detail)).toEqual([
      expect.objectContaining({ zdroj: 'stranka-role', pridano: ['web'], odebrano: [] }),
      expect.objectContaining({ zdroj: 'detail-uctu', pridano: ['deska'], odebrano: ['web'] }),
    ]);

    const h = await buh.get(`/sprava/role/historie?uzivatel=${cil.id}`);
    expect(h.res.status).toBe(200);
    expect(h.text).toContain('Historie změn rolí: Hana Historická');
    expect(h.text).toContain('Záznamů: 2');
    expect(h.text).toContain('stránka Role');
    expect(h.text).toContain('detail účtu');
    // poslední změny i na stránce Role
    expect((await buh.get('/sprava/role')).text).toContain('Poslední změny rolí');
    // správce vidí historii, občan ne
    const spr = await prihlasSRoli(t, '777911003', ['spravce']);
    expect((await spr.get('/sprava/role/historie')).res.status).toBe(200);
    await t.db.updateTable('uzivatele').set({ role: [] }).where('id', '=', cil.id).execute();
  });

  it('rozdíl ze starších záznamů se dopočítá z role/puvodne', () => {
    expect(rozdilZDetailu({ role: ['web', 'deska'], puvodne: ['web', 'kviz'] })).toEqual({
      pridano: ['deska'],
      odebrano: ['kviz'],
    });
    expect(rozdilZDetailu({ pridano: 'admin' })).toEqual({ pridano: ['admin'], odebrano: [] });
  });
});

describe('poslední aktivita a spící účty', () => {
  it('silná role bez přihlášení přes 90 dní = spí; čerstvý účet ani občan nespí', () => {
    const stary = new Date(Date.now() - 200 * 86_400_000);
    const zaklad = { vytvoren_at: stary, blokovan_at: null };
    expect(jeSpici({ ...zaklad, role: ['admin'] }, undefined)).toBe(true);
    expect(jeSpici({ ...zaklad, role: ['admin'] }, { prihlaseni: new Date(), aktivita: null })).toBe(false);
    expect(jeSpici({ ...zaklad, role: ['web'] }, undefined)).toBe(false);
    expect(jeSpici({ role: ['spravce'], vytvoren_at: new Date(), blokovan_at: null }, undefined)).toBe(false);
  });

  it('na stránce Role je poslední přihlášení a štítek spícího účtu', async () => {
    await ucet('+420777912001', ['admin'], {
      jmeno: 'Spáč',
      prijmeni: 'Dlouhý',
      vytvoren_at: new Date(Date.now() - 400 * 86_400_000),
    });
    await t.db
      .updateTable('uzivatele')
      .set({ vytvoren_at: new Date(Date.now() - 400 * 86_400_000) })
      .where('telefon', '=', '+420777912001')
      .execute();
    const spr = await prihlasSRoli(t, '777912002', ['spravce']);
    const s = await spr.get('/sprava/role');
    expect(s.text).toMatch(/Spáč Dlouhý[\s\S]*?zatím nepřihlášen\(a\)[\s\S]*?spí — přes 90 dní/);
    expect(s.text).toContain('Spících účtů se silnou rolí');
    await t.db.updateTable('uzivatele').set({ role: [] }).where('telefon', '=', '+420777912001').execute();
  });
});

describe('e-mail při udělení silné role', () => {
  it('ostatní administrátoři s e-mailem dostanou zprávu (stránka Role i detail), nový admin ne', async () => {
    const buh = await prihlasSRoli(t, '777913001', ['provozovatel']);
    await t.db
      .updateTable('uzivatele')
      .set({ email: 'buh@example.test', jmeno: 'Bohumil' })
      .where('telefon', '=', '+420777913001')
      .execute();
    await ucet('+420777913002', ['admin'], { email: 'druhy-admin@example.test' });
    await ucet('+420777913003', ['spravce'], { email: 'spravce@example.test' });
    const cil = await ucet('+420777913004', [], {
      email: 'novy@example.test',
      jmeno: 'Nový',
      prijmeni: 'Admin',
    });
    const pred = t.mail.odeslane.length;
    const s = await buh.get('/sprava/role');
    await buh.post('/sprava/role/admin/pridat', {
      _csrf: csrfZ(s.text),
      uzivatel: cil.id,
      plati_do: zitra(),
    });
    const nove = t.mail.odeslane.slice(pred);
    const komu = nove.map((m) => m.komu);
    expect(komu).toContain('druhy-admin@example.test');
    expect(komu).toContain('buh@example.test');
    expect(komu).not.toContain('novy@example.test');
    expect(komu).not.toContain('spravce@example.test');
    const zprava = nove.find((m) => m.komu === 'druhy-admin@example.test')!;
    expect(zprava.predmet).toContain('Nový Admin');
    expect(zprava.text).toContain('Přidělil(a): Bohumil');
    expect(zprava.text).toContain('platí do');
    expect(zprava.text).toContain(`/sprava/role/historie?uzivatel=${cil.id}`);

    // běžná role e-mail nespouští
    const pred2 = t.mail.odeslane.length;
    const d = await buh.get(`/sprava/uzivatele/${cil.id}`);
    await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrfZ(d.text),
      akce: 'role',
      role: ['admin', 'web'],
    });
    expect(t.mail.odeslane.length).toBe(pred2);

    // chyba odeslání nesmí shodit uložení role (detail účtu, role provozovatel)
    const puvodni = t.mail.posli.bind(t.mail);
    t.mail.posli = async () => {
      throw new Error('SMTP nedostupné pro x@y.cz');
    };
    try {
      const d2 = await buh.get(`/sprava/uzivatele/${cil.id}`);
      const r = await buh.post(`/sprava/uzivatele/${cil.id}`, {
        _csrf: csrfZ(d2.text),
        akce: 'role',
        role: ['provozovatel'],
      });
      expect(r.text).toContain('Role uloženy');
      expect(await roleUctu(cil.id)).toEqual(['provozovatel']);
    } finally {
      t.mail.posli = puvodni;
    }
    // stav systému eviduje chybu bez adres
    const admin = await prihlasSRoli(t, '777913005', ['admin']);
    const sys = await admin.get('/sprava/system');
    expect(sys.text).toContain('SMTP nedostupné pro …@…');
    await t.db.updateTable('uzivatele').set({ role: [] }).where('id', '=', cil.id).execute();
    await t.db
      .updateTable('uzivatele')
      .set({ role: [] })
      .where('telefon', 'in', ['+420777913002', '+420777913005'])
      .execute();
  });

  it('adresy z chyb SMTP se maskují', () => {
    expect(bezAdres('550 <nekdo@example.cz> neexistuje')).toBe('550 <…@…> neexistuje');
  });
});

describe('přihlášená zařízení a odhlášení na dálku', () => {
  it('admin vidí sezení účtu a odhlásí ho všude; uživatel pak není přihlášený nikde', async () => {
    const tel = '777914001';
    await ucet('+420' + tel, ['web']);
    const p1 = new Prohlizec(t.base);
    p1.hlavicky['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0';
    await prihlasTelefonem(p1, '+420' + tel);
    expect((await p1.get('/ucet')).res.status).toBe(200);
    const p2 = await prihlasSRoli(t, tel, ['web']);
    const uid = await idUctu('+420' + tel);
    const admin = await prihlasSRoli(t, '777914002', ['admin']);
    const d = await admin.get(`/sprava/uzivatele/${uid}`);
    expect(d.text).toContain('Přihlášená zařízení');
    expect(d.text).toContain('Firefox · Windows');
    expect(d.text).not.toMatch(/name="sezeni" value="[^"]{17,}"/); // jen otisk, ne tajné sid
    const otisky = [...d.text.matchAll(/name="sezeni" value="([0-9a-f]{16})"/g)].map((m) => m[1]);
    expect(otisky.length).toBe(2);

    // jedno zařízení
    await admin.post(`/sprava/uzivatele/${uid}/zarizeni`, { _csrf: csrfZ(d.text), sezeni: otisky[0]! });
    const zbyva = await t.db
      .selectFrom('sezeni')
      .select('sid')
      .where(sql<boolean>`data->>'uzivatelId' = ${uid}`)
      .execute();
    expect(zbyva.length).toBe(1);

    // všechna zařízení: i OIDC sezení u providera (jinak by se tiše přihlásil zpět)
    const d2 = await admin.get(`/sprava/uzivatele/${uid}`);
    const r = await admin.post(`/sprava/uzivatele/${uid}/zarizeni`, { _csrf: csrfZ(d2.text) });
    expect(r.text).toContain('Odhlášeno zařízení');
    for (const p of [p1, p2]) {
      const u = await p.get('/ucet', false);
      expect(u.res.status).toBe(302);
      expect(u.res.headers.get('location')).toContain('/prihlaseni');
    }
    const oidc = await t.db
      .selectFrom('oidc_payloads')
      .select('id')
      .where(sql<boolean>`payload->>'accountId' = ${uid}`)
      .execute();
    expect(oidc).toEqual([]);
    // „Přihlásit“ teď vede na přihlašovací formulář, ne tiše zpět do účtu
    const znovu = await p1.get('/prihlaseni');
    expect(znovu.url).toContain('/oidc/interaction/');
    const audit = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'sprava.odhlaseni_zarizeni')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => (a.detail as { rozsah: string }).rozsah)).toEqual(['jedno', 'vse']);
  });

  it('správce (bez admina) zařízení nevidí ani neodhlásí', async () => {
    const uid = await idUctu('+420777914002');
    const spr = await prihlasSRoli(t, '777914003', ['spravce']);
    const d = await spr.get(`/sprava/uzivatele/${uid}`);
    expect(d.text).not.toContain('id="zarizeni"');
    const r = await spr.post(`/sprava/uzivatele/${uid}/zarizeni`, { _csrf: csrfZ(d.text) }, false);
    expect(r.res.status).toBe(403);
  });

  it('Můj účet: vlastní zařízení a odhlášení ostatních', async () => {
    const tel = '777914004';
    const a = await prihlasSRoli(t, tel, []);
    const b = await prihlasSRoli(t, tel, []);
    const s = await a.get('/ucet/zarizeni');
    expect(s.res.status).toBe(200);
    expect(s.text).toContain('toto zařízení');
    await a.post('/ucet/zarizeni', { _csrf: csrfZ(s.text) });
    expect((await a.get('/ucet', false)).res.status).toBe(200);
    expect((await b.get('/ucet', false)).res.status).toBe(302);
  });

  it('zkrácený popis prohlížeče', () => {
    expect(
      zkratProhlizec('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Safari/604.1'),
    ).toBe('Safari · iPhone');
    expect(zkratProhlizec('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537 Edg/130')).toBe(
      'Edge · Windows',
    );
    expect(zkratProhlizec('')).toBeNull();
  });
});

describe('stav systému', () => {
  it('jen administrátor; ukazuje migrace, e-mail, zálohy a nic neodesílá', async () => {
    const admin = await prihlasSRoli(t, '777915001', ['admin']);
    const predSms = t.sms.odeslane.length;
    const predMail = t.mail.odeslane.length;
    const s = await admin.get('/sprava/system');
    expect(s.res.status).toBe(200);
    expect(s.text).toContain('0025_role_platnost_sezeni');
    expect(s.text).toContain('Automatické zálohy nejsou nastavené');
    expect(s.text).toContain('Hlídání GSM brány');
    expect(t.sms.odeslane.length).toBe(predSms);
    expect(t.mail.odeslane.length).toBe(predMail);
    expect((await admin.get('/sprava')).text).toContain('href="/sprava/system"');
    const spr = await prihlasSRoli(t, '777915002', ['spravce']);
    expect((await spr.get('/sprava/system')).res.status).toBe(403);
    expect((await spr.get('/sprava')).text).not.toContain('href="/sprava/system"');
  });

  it('nejnovější záloha v adresáři', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zalohy-'));
    writeFileSync(path.join(dir, 'stara.sql.gz'), 'x');
    utimesSync(path.join(dir, 'stara.sql.gz'), new Date('2026-01-01'), new Date('2026-01-01'));
    writeFileSync(path.join(dir, 'nova.sql.gz'), 'xyz');
    const z = await posledniZaloha(dir);
    expect(z.pocet).toBe(2);
    expect(z.posledni).toMatchObject({ nazev: 'nova.sql.gz', velikost: 3 });
  });
});

describe('dočasné role', () => {
  it('datum platnosti: prázdné = trvale, dnešek a minulost neplatné, den platí celý', () => {
    expect(platiDoZDatumu('')).toBeNull();
    expect(platiDoZDatumu(datumPraha(new Date()))).toBe('neplatne');
    expect(platiDoZDatumu('2020-01-01')).toBe('neplatne');
    expect(platiDoZDatumu('2026-02-30')).toBe('neplatne');
    const d = platiDoZDatumu('2099-12-31');
    expect(d instanceof Date && datumPraha(d)).toBe('2099-12-31');
  });

  it('přidání s platností, vypršení odebere roli i před během plánovače, audit „vypršela platnost“', async () => {
    const buh = await prihlasSRoli(t, '777916001', ['provozovatel']);
    const p = await prihlasSRoli(t, '777916002', []);
    const uid = await idUctu('+420777916002');
    const s = await buh.get('/sprava/role');
    await buh.post('/sprava/role/web/pridat', { _csrf: csrfZ(s.text), uzivatel: uid, plati_do: zitra() });
    expect(await roleUctu(uid)).toEqual(['web']);
    const radek = await t.db
      .selectFrom('role_platnost')
      .selectAll()
      .where('uzivatel_id', '=', uid)
      .executeTakeFirstOrThrow();
    expect(radek.role).toBe('web');
    expect((await buh.get('/sprava/role')).text).toMatch(/do \d+\. \d+\. \d{4}/);
    expect((await p.get('/sprava/web/stranky')).res.status).toBe(200);

    // platnost uplynula — plánovač ještě neběžel, oprávnění už ale neplatí
    await t.db
      .updateTable('role_platnost')
      .set({ plati_do: new Date(Date.now() - 1000) })
      .where('uzivatel_id', '=', uid)
      .execute();
    expect((await p.get('/sprava/web/stranky')).res.status).toBe(403);
    expect(await roleUctu(uid)).toEqual([]);
    expect(
      await t.db.selectFrom('role_platnost').select('role').where('uzivatel_id', '=', uid).execute(),
    ).toEqual([]);
    const a = await t.db
      .selectFrom('audit_log')
      .select(['detail', 'uzivatel_id'])
      .where('akce', '=', 'sprava.role')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(a.uzivatel_id).toBeNull();
    expect(a.detail).toMatchObject({ cil: uid, zdroj: 'vyprseni', odebrano: ['web'] });
    expect((await buh.get(`/sprava/role/historie?uzivatel=${uid}`)).text).toContain('vypršela platnost');
  });

  it('detail účtu: platnost se nastaví, zruší (trvale) a odebraná role ztratí platnost; provozovatel jen trvale', async () => {
    const buh = await prihlasSRoli(t, '777917001', ['provozovatel']);
    const cil = await ucet('+420777917002', []);
    const d = await buh.get(`/sprava/uzivatele/${cil.id}`);
    const csrf = csrfZ(d.text);
    await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['web', 'deska'],
      plati_do_web: '2099-06-30',
      plati_do_deska: '',
    });
    const pl = async () =>
      (
        await t.db
          .selectFrom('role_platnost')
          .select(['role', 'plati_do'])
          .where('uzivatel_id', '=', cil.id)
          .execute()
      ).map((x) => [x.role, datumPraha(x.plati_do)]);
    expect(await pl()).toEqual([['web', '2099-06-30']]);
    expect((await buh.get(`/sprava/uzivatele/${cil.id}`)).text).toContain('value="2099-06-30"');
    // nově trvale
    await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['web', 'deska'],
      plati_do_web: '',
    });
    expect(await pl()).toEqual([]);
    // odebraná role ztrácí platnost
    await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['web', 'deska'],
      plati_do_deska: '2099-01-01',
    });
    await buh.post(`/sprava/uzivatele/${cil.id}`, { _csrf: csrf, akce: 'role', role: ['web'] });
    expect(await pl()).toEqual([]);
    // neplatné datum a dočasný provozovatel se odmítnou
    const r1 = await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['web'],
      plati_do_web: '2001-01-01',
    });
    expect(r1.text).toContain('nejdřív zítřejší');
    const r2 = await buh.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrf,
      akce: 'role',
      role: ['provozovatel'],
      plati_do_provozovatel: '2099-01-01',
    });
    expect(r2.text).toContain('nelze přidělit dočasně');
    expect(await roleUctu(cil.id)).toEqual(['web']);
    const s = await buh.get('/sprava/role');
    const r3 = await buh.post('/sprava/role/provozovatel/pridat', {
      _csrf: csrfZ(s.text),
      uzivatel: cil.id,
      plati_do: '2099-01-01',
    });
    expect(r3.text).toContain('nelze přidělit dočasně');
  });

  it('plánovač (vyprsRole) odebere vypršené role všem najednou a platné nechá', async () => {
    const a = await ucet('+420777918001', ['web', 'kviz']);
    const b = await ucet('+420777918002', ['deska']);
    await t.db
      .insertInto('role_platnost')
      .values([
        { uzivatel_id: a.id, role: 'web', plati_do: new Date(Date.now() - 60_000) },
        { uzivatel_id: a.id, role: 'kviz', plati_do: new Date(Date.now() + 86_400_000) },
        { uzivatel_id: b.id, role: 'deska', plati_do: new Date(Date.now() - 60_000) },
      ])
      .execute();
    const r = await vyprsRole(t.db);
    expect(r.get(a.id)).toEqual(['kviz']);
    expect(r.get(b.id)).toEqual([]);
    expect(await roleUctu(a.id)).toEqual(['kviz']);
    expect(await roleUctu(b.id)).toEqual([]);
    expect((await vyprsRole(t.db)).size).toBe(0);
  });
});
