// Externí OIDC klient: discovery, Authorization Code + PKCE, výměna kódu, ID token, userinfo, obrazovka souhlasu, refresh.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { csrfZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
const KLIENT = {
  id: 'test-klient',
  secret: 'test-tajemstvi-1234567890',
  redirect: 'http://localhost:9999/callback',
};

beforeAll(async () => {
  t = await spustTestApp();
  await t.db
    .insertInto('oidc_klienti')
    .values({
      client_id: KLIENT.id,
      client_secret: KLIENT.secret,
      nazev: 'Testovací aplikace',
      redirect_uris: [KLIENT.redirect],
      duveryhodny: false,
    })
    .execute();
});
afterAll(async () => t.zavri());

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OIDC provider', () => {
  it('discovery a JWKS', async () => {
    const d = (await (await fetch(`${t.base}/oidc/.well-known/openid-configuration`)).json()) as Record<
      string,
      unknown
    >;
    expect(d.issuer).toBe(`${t.base}/oidc`);
    expect(d.authorization_endpoint).toBe(`${t.base}/oidc/auth`);
    expect(d.token_endpoint).toBe(`${t.base}/oidc/token`);
    expect(d.userinfo_endpoint).toBe(`${t.base}/oidc/me`);
    expect(d.scopes_supported).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email', 'phone', 'obec']),
    );
    expect(d.code_challenge_methods_supported).toEqual(['S256']);
    const jwks = (await (await fetch(`${t.base}/oidc/jwks`)).json()) as {
      keys: { kty: string; alg?: string }[];
    };
    expect(jwks.keys.map((k) => k.alg).sort()).toEqual(['ES256', 'RS256']);
    expect(jwks.keys.every((k) => !('d' in k))).toBe(true);
  });

  it('PKCE je povinné', async () => {
    const u = new URL(`${t.base}/oidc/auth`);
    u.searchParams.set('client_id', KLIENT.id);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', KLIENT.redirect);
    u.searchParams.set('scope', 'openid');
    const r = await fetch(u, { redirect: 'manual' });
    const loc = r.headers.get('location') ?? '';
    expect(loc).toContain('error=invalid_request');
    expect(loc).toContain('PKCE');
  });

  it('celý tok externího klienta: přihlášení, souhlas, kód, tokeny, userinfo, refresh', async () => {
    const p = new Prohlizec(t.base);
    const { verifier, challenge } = pkce();
    const u = new URL(`${t.base}/oidc/auth`);
    u.searchParams.set('client_id', KLIENT.id);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', KLIENT.redirect);
    u.searchParams.set('scope', 'openid profile phone obec offline_access');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', 'stav123');
    u.searchParams.set('nonce', 'nonce123');
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');

    // 1) interakce: přihlášení telefonem (uživatel ještě neexistuje → GDPR souhlas)
    const inter = await p.get(u.href);
    expect(inter.url).toContain('/oidc/interaction/');
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    const kodStranka = await p.post(`/oidc/interaction/${uid}/telefon`, {
      _csrf: csrfZ(inter.text),
      telefon: '777200100',
    });
    const kod = /kód z SMS je (\d{6})/.exec(kodStranka.text)![1]!;
    const souhlasStranka = await p.post(`/oidc/interaction/${uid}/kod`, {
      _csrf: csrfZ(kodStranka.text),
      telefon: '+420777200100',
      kod,
    });
    expect(souhlasStranka.text).toContain('Souhlas se zpracováním osobních údajů');
    // 2) po GDPR souhlasu provider žádá souhlas s přístupem (klient není důvěryhodný)
    const pristup = await p.post(`/oidc/interaction/${uid}/souhlas`, {
      _csrf: csrfZ(souhlasStranka.text),
      souhlas: 'ano',
    });
    expect(pristup.text).toContain('Povolit přístup aplikaci');
    expect(pristup.text).toContain('Testovací aplikace');
    expect(pristup.text).toContain('telefonní číslo');
    const uid2 = pristup.url.split('/oidc/interaction/')[1]!;
    // 3) povolit → přesměrování na redirect_uri s kódem
    const zpet = await p.post(
      `/oidc/interaction/${uid2}/pristup`,
      { _csrf: csrfZ(pristup.text), rozhodnuti: 'povolit' },
      false,
    );
    let loc = zpet.res.headers.get('location')!;
    // resume → redirect na klienta
    for (let i = 0; i < 3 && !loc.startsWith(KLIENT.redirect); i++) {
      const r = await p.get(loc, false);
      loc = r.res.headers.get('location') ?? '';
    }
    expect(loc.startsWith(KLIENT.redirect)).toBe(true);
    const cb = new URL(loc);
    expect(cb.searchParams.get('state')).toBe('stav123');
    const code = cb.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 4) výměna kódu za tokeny (client_secret_basic)
    const tr = await fetch(`${t.base}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${KLIENT.id}:${KLIENT.secret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KLIENT.redirect,
        code_verifier: verifier,
      }),
    });
    expect(tr.status).toBe(200);
    const tokeny = (await tr.json()) as {
      access_token: string;
      id_token: string;
      refresh_token?: string;
      token_type: string;
    };
    expect(tokeny.token_type).toBe('Bearer');
    expect(tokeny.refresh_token).toBeTruthy();

    // 5) ID token ověřený proti JWKS
    const JWKS = jose.createRemoteJWKSet(new URL(`${t.base}/oidc/jwks`));
    const { payload, protectedHeader } = await jose.jwtVerify(tokeny.id_token, JWKS, {
      issuer: `${t.base}/oidc`,
      audience: KLIENT.id,
    });
    expect(protectedHeader.alg).toBe('ES256');
    expect(payload.nonce).toBe('nonce123');
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);

    // 6) userinfo s claims podle rozsahu
    const ui = (await (
      await fetch(`${t.base}/oidc/me`, { headers: { authorization: `Bearer ${tokeny.access_token}` } })
    ).json()) as Record<string, unknown>;
    expect(ui.sub).toBe(payload.sub);
    expect(ui.phone_number).toBe('+420777200100');
    expect(ui.phone_number_verified).toBe(true);
    expect(ui.role).toEqual([]);
    expect(ui.rezident).toBe(false);
    expect(ui.email).toBeUndefined(); // scope email nebyl žádán

    // 7) refresh token
    const rr = await fetch(`${t.base}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${KLIENT.id}:${KLIENT.secret}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokeny.refresh_token! }),
    });
    expect(rr.status).toBe(200);
    expect(((await rr.json()) as { access_token: string }).access_token).toBeTruthy();

    // 8) opakovaný kód je odmítnut
    const znovu = await fetch(`${t.base}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${KLIENT.id}:${KLIENT.secret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KLIENT.redirect,
        code_verifier: verifier,
      }),
    });
    expect(znovu.status).toBe(400);
  });

  it('odmítnutí souhlasu vrátí access_denied; neznámý klient = chyba', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200200'); // sezení u providera už existuje
    const { challenge } = pkce();
    const u = new URL(`${t.base}/oidc/auth`);
    u.searchParams.set('client_id', KLIENT.id);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', KLIENT.redirect);
    u.searchParams.set('scope', 'openid');
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    const inter = await p.get(u.href);
    expect(inter.text).toContain('Povolit přístup aplikaci');
    const uid = inter.url.split('/oidc/interaction/')[1]!;
    const r = await p.post(
      `/oidc/interaction/${uid}/pristup`,
      { _csrf: csrfZ(inter.text), rozhodnuti: 'odmitnout' },
      false,
    );
    let loc = r.res.headers.get('location')!;
    for (let i = 0; i < 3 && !loc.startsWith(KLIENT.redirect); i++)
      loc = (await p.get(loc, false)).res.headers.get('location') ?? '';
    expect(loc).toContain('error=access_denied');

    const neznamy = await fetch(
      `${t.base}/oidc/auth?client_id=cizi&response_type=code&redirect_uri=http://x/&scope=openid`,
      { headers: { accept: 'text/html' } },
    );
    expect(neznamy.status).toBe(400);
    expect(await neznamy.text()).toContain('Přihlášení se nezdařilo');
  });

  it('platforma sama je důvěryhodný klient (bez obrazovky souhlasu)', async () => {
    const p = new Prohlizec(t.base);
    const po = await prihlasTelefonem(p, '777200300');
    expect(po.text).not.toContain('Povolit přístup aplikaci');
    expect(po.url).toContain('/ucet');
  });
});
