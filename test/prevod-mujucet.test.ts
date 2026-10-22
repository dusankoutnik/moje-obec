// Převod účtů z MůjÚčtu (vymyšlená data): role, hesla scrypt MůjÚčtu, idempotence, přečíslování demo účtu,
// anonymizace; OIDC tok klienta „rezervace“ s claims mujucet_id; interní API uživatelů.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csrfZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';
import {
  casZPrahy,
  prevedHash,
  prevedUcty,
  roleZMujUctu,
  type MujUcetRadek,
} from '../src/moduly/ucty/prevod.js';

const REZ_SECRET = 'rezervace-tajemstvi-1234567890';
const API_SECRET = 'interni-api-tajemstvi-1234567890';
let t: TestApp;

// heslo přesně jako MůjÚčet (util.hashPassword)
function hashMujUcet(heslo: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(heslo, salt, 64).toString('hex')}`;
}

function radek(id: number, x: Partial<MujUcetRadek> = {}): MujUcetRadek {
  return {
    id,
    name: `Jan Testovací${id}`,
    nickname: `Jan${id}`,
    phone: `+420600000${String(id).padStart(3, '0')}`,
    email: null,
    password_hash: null,
    role: 'user',
    roles: '',
    verified_at: '2026-09-01 10:00:00',
    blocked_at: null,
    village: 'Testov',
    created_at: '2026-08-20 16:40:58',
    gdpr_consent_at: '2026-09-08 14:40:41',
    first_name: 'Jan',
    last_name: `Testovací${id}`,
    is_resident: 1,
    ...x,
  };
}

const ZDROJ: MujUcetRadek[] = [
  radek(1, {
    role: 'admin',
    roles: 'admin,vstupne',
    email: 'admin@testov.cz',
    password_hash: hashMujUcet('tajne-heslo-1'),
  }),
  radek(2, { role: 'ucetni', roles: 'ucetni,redaktor', is_resident: 0 }),
  radek(3, { role: 'spravce', roles: 'spravce' }),
  radek(5, { blocked_at: '2026-10-01 08:00:00' }),
  radek(6, {
    name: '[vymazáno]',
    first_name: '',
    last_name: '[vymazáno]',
    phone: 'smazano-6',
    blocked_at: '2026-10-02 08:00:00',
  }),
  radek(9, {
    first_name: '',
    last_name: '',
    name: 'Marie Anna Stará',
    gdpr_consent_at: null,
    color: '#123456',
  }),
];

beforeAll(async () => {
  t = await spustTestApp({
    env: { OIDC_REZERVACE_SECRET: REZ_SECRET, INTERNI_API_SECRET: API_SECRET },
  });
});
afterAll(async () => t.zavri());

describe('pomocné převody', () => {
  it('role MůjÚčtu → role platformy', () => {
    expect(roleZMujUctu({ role: 'admin', roles: 'admin,vstupne' })).toEqual(['admin', 'vstupne']);
    expect(roleZMujUctu({ role: 'spravce', roles: 'spravce' })).toEqual(['deska', 'spravce', 'web']);
    expect(roleZMujUctu({ role: 'ucetni', roles: 'ucetni,redaktor' })).toEqual([
      'deska',
      'redaktor',
      'ucetni',
      'web',
    ]);
    expect(roleZMujUctu({ role: 'ucetni', roles: 'ucetni,redaktor' }, false)).toEqual(['redaktor', 'ucetni']);
    expect(roleZMujUctu({ role: 'user', roles: '' })).toEqual([]);
  });
  it('hash a čas', () => {
    expect(prevedHash('abc')).toBeNull();
    expect(prevedHash(hashMujUcet('x'))).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    // léto (CEST, +2) i zima (CET, +1)
    expect(casZPrahy('2026-08-20 16:40:58')!.toISOString()).toBe('2026-08-20T14:40:58.000Z');
    expect(casZPrahy('2026-12-01 08:00:00')!.toISOString()).toBe('2026-12-01T07:00:00.000Z');
  });
});

describe('převod účtů', () => {
  it('převede, přečísluje demo účet, ohlásí konflikt a je idempotentní', async () => {
    // demo účet platformy (číslo 1 z migrace) a účet, který koliduje telefonem s účtem 9
    const demo = await t.db
      .insertInto('uzivatele')
      .values({ telefon: '+420777000001', email: null, heslo_hash: null, role: ['admin'] })
      .returningAll()
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('uzivatele')
      .values({ telefon: '+420600000009', email: null, heslo_hash: null })
      .execute();
    expect(demo.cislo).toBeLessThan(10);

    const v = await prevedUcty(t.db, ZDROJ);
    expect(v).toMatchObject({
      zdroj: 6,
      vynechano_vymazane: 1,
      zalozeno: 4,
      s_heslem: 1,
      blokovano: 1,
      s_rolemi: 3,
    });
    expect(v.konflikty).toHaveLength(1);
    expect(v.konflikty[0]!.cislo).toBe(9);
    expect(v.precislovano).toBeGreaterThanOrEqual(1);

    const demoPo = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('id', '=', demo.id)
      .executeTakeFirstOrThrow();
    expect(demoPo.cislo).toBeGreaterThan(9);
    expect(demoPo.role).toEqual(['admin']); // demo účet beze změny údajů

    const admin = (await t.app.ucty.podleCisla(1))!;
    expect(admin.role).toEqual(['admin', 'vstupne']);
    expect(admin.prezdivka).toBe('Jan1');
    expect(admin.heslo_hash).toMatch(/^scrypt\$16384\$/);
    expect(admin.vytvoren_at.toISOString()).toBe('2026-08-20T14:40:58.000Z');
    expect(admin.navic).toMatchObject({ zdroj: 'mujucet', hlavni_role: 'admin' });
    const ucetni = (await t.app.ucty.podleCisla(2))!;
    expect(ucetni.rezident).toBe(false);
    expect((await t.app.ucty.podleCisla(5))!.blokovan_at).toBeTruthy();
    expect(await t.app.ucty.podleCisla(6)).toBeUndefined();

    // druhý běh: nic nového, jen aktualizace
    const v2 = await prevedUcty(t.db, ZDROJ);
    expect(v2.zalozeno).toBe(0);
    expect(v2.aktualizovano).toBe(4);

    // nový účet platformy dostane další číslo za MůjÚčtem
    const novy = await t.db
      .insertInto('uzivatele')
      .values({ telefon: '+420600111222', email: null, heslo_hash: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(novy.cislo).toBeGreaterThan(Math.max(9, demoPo.cislo));
  });

  it('sloučení telefonem připojí údaje MůjÚčtu ke stávajícímu účtu', async () => {
    const v = await prevedUcty(t.db, ZDROJ, { sloucitTelefonem: true });
    expect(v.slouceno).toBe(1);
    expect(v.konflikty).toHaveLength(0);
    const u = (await t.app.ucty.podleCisla(9))!;
    expect(u.telefon).toBe('+420600000009');
    expect(u.jmeno).toBe('Marie Anna');
    expect(u.prijmeni).toBe('Stará');
    expect(u.navic).toMatchObject({ barva: '#123456' });
  });

  it('heslo z MůjÚčtu funguje a po přihlášení se přepočítá', async () => {
    expect(await t.app.ucty.prihlasHeslem('admin@testov.cz', 'spatne')).toBeNull();
    const u = await t.app.ucty.prihlasHeslem('admin@testov.cz', 'tajne-heslo-1');
    expect(u?.cislo).toBe(1);
    const po = (await t.app.ucty.podleCisla(1))!;
    expect(po.heslo_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
    // další převod přepočítané heslo nepřepíše starým
    await prevedUcty(t.db, ZDROJ);
    expect((await t.app.ucty.podleCisla(1))!.heslo_hash).toBe(po.heslo_hash);
  });

  it('anonymizace pro dev', async () => {
    const zdroj = [radek(40, { email: 'skutecny@seznam.cz', password_hash: hashMujUcet('x') }), radek(41)];
    const v = await prevedUcty(t.db, zdroj, { anonymizovat: true });
    expect(v.zalozeno).toBe(2);
    const u = (await t.app.ucty.podleCisla(40))!;
    expect(u).toMatchObject({
      jmeno: 'Občan',
      prijmeni: '40',
      prezdivka: 'Občan 40',
      telefon: '+420770000040',
      email: 'ucet40@dev.invalid',
      heslo_hash: null,
    });
  });

  it('čte SQLite MůjÚčtu (node:sqlite)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mujucet-'));
    const s = new DatabaseSync(join(dir, 'mujucet.db'));
    s.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, nickname TEXT, phone TEXT, email TEXT,
      password_hash TEXT, role TEXT, verified_at TEXT, blocked_at TEXT, created_at TEXT)`);
    s.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      7,
      'A B',
      'A',
      '+420600000007',
      null,
      null,
      'user',
      null,
      null,
      '2026-09-01 00:00:00',
    );
    const r = s.prepare('SELECT * FROM users').all();
    s.close();
    expect(r).toHaveLength(1);
  });
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OIDC klient rezervace', () => {
  it('klient z env je zaregistrovaný jako důvěryhodný s redirect URI pod /rezervace', async () => {
    const k = await t.db
      .selectFrom('oidc_klienti')
      .selectAll()
      .where('client_id', '=', 'rezervace')
      .executeTakeFirstOrThrow();
    expect(k.duveryhodny).toBe(true);
    expect(k.redirect_uris).toEqual([`${t.base}/rezervace/prihlaseni/callback`]);
    expect(k.post_logout_redirect_uris).toEqual([`${t.base}/`]);
    expect(
      await t.db.selectFrom('oidc_klienti').where('client_id', '=', 'eknihy').selectAll().execute(),
    ).toEqual([]);
  });

  it('authorize → přihlášení heslem → kód → tokeny → claims s mujucet_id → odhlášení', async () => {
    const p = new Prohlizec(t.base);
    const { verifier, challenge } = pkce();
    const redirect = `${t.base}/rezervace/prihlaseni/callback`;
    const u = new URL(`${t.base}/oidc/auth`);
    for (const [k, v] of Object.entries({
      client_id: 'rezervace',
      response_type: 'code',
      redirect_uri: redirect,
      scope: 'openid profile email phone obec',
      state: 's1',
      nonce: 'n1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }))
      u.searchParams.set(k, v);
    const inter = await p.get(u.href);
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    const hesloStr = await p.get(`/oidc/interaction/${uid}/heslo`);
    const po = await p.post(
      `/oidc/interaction/${uid}/heslo`,
      { _csrf: csrfZ(hesloStr.text), email: 'admin@testov.cz', heslo: 'tajne-heslo-1' },
      false,
    );
    let loc = po.res.headers.get('location') ?? '';
    for (let i = 0; i < 4 && !loc.startsWith(redirect); i++)
      loc = (await p.get(loc, false)).res.headers.get('location') ?? '';
    expect(loc.startsWith(redirect)).toBe(true); // bez obrazovky souhlasu
    const code = new URL(loc).searchParams.get('code')!;

    const tr = await fetch(`${t.base}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`rezervace:${REZ_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    });
    expect(tr.status).toBe(200);
    const tok = (await tr.json()) as { access_token: string; id_token: string };
    const JWKS = jose.createRemoteJWKSet(new URL(`${t.base}/oidc/jwks`));
    const { payload } = await jose.jwtVerify(tok.id_token, JWKS, {
      issuer: `${t.base}/oidc`,
      audience: 'rezervace',
    });
    expect(payload.nonce).toBe('n1');

    const ui = (await (
      await fetch(`${t.base}/oidc/me`, { headers: { authorization: `Bearer ${tok.access_token}` } })
    ).json()) as Record<string, unknown>;
    expect(ui).toMatchObject({
      sub: payload.sub,
      mujucet_id: 1,
      given_name: 'Jan',
      family_name: 'Testovací1',
      nickname: 'Jan1',
      email: 'admin@testov.cz',
      phone_number: '+420600000001',
      rezident: true,
      cast_obce: 'Testov',
      role: ['admin', 'vstupne'],
    });

    // odhlášení s návratem na úvod
    const end = new URL(`${t.base}/oidc/session/end`);
    end.searchParams.set('id_token_hint', tok.id_token);
    end.searchParams.set('post_logout_redirect_uri', `${t.base}/`);
    const formular = await p.get(end.href);
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(formular.text)![1]!;
    const akce = /action="([^"]+)"/.exec(formular.text)![1]!;
    const odh = await p.post(akce, { xsrf, logout: 'yes' }, false);
    let l2 = odh.res.headers.get('location') ?? '';
    for (let i = 0; i < 3 && l2 && l2 !== `${t.base}/`; i++)
      l2 = (await p.get(l2, false)).res.headers.get('location') ?? '';
    expect(l2).toBe(`${t.base}/`);
  });
});

describe('odhlášení z aplikace přes end_session', () => {
  it('ukončí i sezení platformy', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777300400');
    expect((await p.get('/ucet')).url).toContain('/ucet');
    // aplikace pošle prohlížeč na end_session (bez id_token_hint stačí client_id)
    const end = new URL(`${t.base}/oidc/session/end`);
    end.searchParams.set('client_id', 'rezervace');
    end.searchParams.set('post_logout_redirect_uri', `${t.base}/`);
    const formular = await p.get(end.href);
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(formular.text)![1]!;
    const akce = /action="([^"]+)"/.exec(formular.text)![1]!;
    const odh = await p.post(akce, { xsrf, logout: 'yes' }, false);
    expect(odh.res.headers.get('location')).toBe(`${t.base}/`);
    // sezení platformy je pryč → /ucet chce znovu přihlášení
    const ucet = await p.get('/ucet', false);
    expect(ucet.res.status).toBe(302);
    expect(ucet.res.headers.get('location')).toContain('/prihlaseni');
  });
});

describe('interní API uživatelů', () => {
  const h = { 'x-api-secret': API_SECRET, 'content-type': 'application/json' };
  it('ověření klíče a zákaz přes proxy', async () => {
    expect((await fetch(`${t.base}/api/interni/uzivatel/1`)).status).toBe(401);
    expect(
      (await fetch(`${t.base}/api/interni/uzivatel/1`, { headers: { 'x-api-secret': 'x' } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${t.base}/api/interni/uzivatel/1`, { headers: { ...h, 'x-forwarded-for': '1.2.3.4' } }))
        .status,
    ).toBe(404);
  });
  it('profil, seznam podle role, přepnutí rezidenta s auditem', async () => {
    const p = (await (await fetch(`${t.base}/api/interni/uzivatel/2`, { headers: h })).json()) as Record<
      string,
      unknown
    >;
    expect(p).toMatchObject({ mujucet_id: 2, rezident: false, role: ['deska', 'redaktor', 'ucetni', 'web'] });
    expect((await fetch(`${t.base}/api/interni/uzivatel/999`, { headers: h })).status).toBe(404);

    const s = (await (
      await fetch(`${t.base}/api/interni/uzivatele?role=spravce,admin`, { headers: h })
    ).json()) as {
      uzivatele: { mujucet_id: number }[];
    };
    expect(s.uzivatele.map((u) => u.mujucet_id)).toEqual(expect.arrayContaining([1, 3]));
    expect(s.uzivatele.map((u) => u.mujucet_id)).not.toContain(2);
    expect((await fetch(`${t.base}/api/interni/uzivatele?role=nic`, { headers: h })).status).toBe(400);

    // kdo musí být správce/admin
    const zle = await fetch(`${t.base}/api/interni/uzivatel/2/rezident`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ rezident: true, kdo: 2 }),
    });
    expect(zle.status).toBe(403);
    const ok = await fetch(`${t.base}/api/interni/uzivatel/2/rezident`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ rezident: true, kdo: 3 }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, cislo: 2, rezident: true, rezident_posouzen_by: 3, blokovan: false });
    const a = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('akce', '=', 'sprava.rezident')
      .executeTakeFirstOrThrow();
    expect(a.detail).toMatchObject({ cislo: 2, rezident: true, zdroj: 'interni-api' });
  });
});
