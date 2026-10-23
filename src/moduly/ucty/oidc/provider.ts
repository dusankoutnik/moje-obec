// Vestavěný OpenID Connect provider (knihovna oidc-provider, certifikovaná). Issuer = <BASE_URL>/oidc.
// Interní moduly i externí aplikace se přihlašují stejně — Authorization Code + PKCE.
import Provider, { type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Db } from '../../../db/index.js';
import type { Env } from '../../../config/env.js';
import type { ObecProfil } from '../../../config/obec.js';
import { vytvorAdapter } from './adapter.js';
import { celeJmeno } from '../sluzba.js';

export const OIDC_PREFIX = '/oidc';
export const PLATFORMA_CLIENT_ID = 'platforma';
export const ROZSAHY = ['openid', 'profile', 'email', 'phone', 'obec', 'offline_access'] as const;

// Podpisové klíče se generují při prvním startu a ukládají do tabulky nastaveni (klíč oidc_jwks),
// aby přežily restart i nový obraz. Jeden ES256 a jeden RS256 (kvůli klientům, kteří umí jen RSA).
async function nactiNeboVytvorJwks(db: Db): Promise<{ keys: JWK[] }> {
  const r = await db
    .selectFrom('nastaveni')
    .select('hodnota')
    .where('klic', '=', 'oidc_jwks')
    .executeTakeFirst();
  if (r) return r.hodnota as { keys: JWK[] };
  const keys: JWK[] = [];
  for (const alg of ['ES256', 'RS256'] as const) {
    const { privateKey } = await generateKeyPair(alg, {
      extractable: true,
      ...(alg === 'RS256' ? { modulusLength: 2048 } : {}),
    });
    const jwk = await exportJWK(privateKey);
    keys.push({ ...jwk, alg, use: 'sig', kid: `${alg.toLowerCase()}-${Date.now().toString(36)}` });
  }
  const jwks = { keys };
  await db
    .insertInto('nastaveni')
    .values({ klic: 'oidc_jwks', hodnota: JSON.stringify(jwks) })
    .onConflict((oc) => oc.column('klic').doNothing())
    .execute();
  // kdyby paralelní start uložil dřív, vezmeme uložené
  const znovu = await db
    .selectFrom('nastaveni')
    .select('hodnota')
    .where('klic', '=', 'oidc_jwks')
    .executeTakeFirstOrThrow();
  return znovu.hodnota as { keys: JWK[] };
}

// Vlastní (first-party) klient platformy — bez obrazovky souhlasu; vzniká/aktualizuje se při startu.
export async function zajistiKlientaPlatformy(db: Db, env: Env): Promise<void> {
  const radek = {
    client_id: PLATFORMA_CLIENT_ID,
    client_secret: env.OIDC_PLATFORMA_SECRET,
    nazev: 'Obecní web od Voltu — platforma',
    redirect_uris: [`${env.BASE_URL}/prihlaseni/callback`],
    post_logout_redirect_uris: [`${env.BASE_URL}/`],
    duveryhodny: true,
    aktivni: true,
  };
  await db
    .insertInto('oidc_klienti')
    .values(radek)
    .onConflict((oc) => oc.column('client_id').doUpdateSet(radek))
    .execute();
}

// Klienti aplikací obce (rezervace, eKnihy) z env — důvěryhodní (první strana, bez obrazovky souhlasu).
// Jednotlivě OIDC_REZERVACE_SECRET / OIDC_EKNIHY_SECRET, nebo JSON pole OIDC_KLIENTI (má přednost u stejného id).
// Klient, který v env není, se nemění (ani nevypíná) — vypnout jde v tabulce oidc_klienti (aktivni=false).
export interface KlientZEnv {
  client_id: string;
  client_secret: string;
  nazev?: string;
  redirect_uris?: string[];
  post_logout_redirect_uris?: string[];
  auth_metoda?: 'client_secret_basic' | 'client_secret_post';
}

const APLIKACE: Record<string, { nazev: string; cesta: string }> = {
  rezervace: { nazev: 'Rezervace', cesta: '/rezervace' },
  eknihy: { nazev: 'eKnihy', cesta: '/eknihy' },
};

export function klientiZEnv(env: Env): KlientZEnv[] {
  const mapa = new Map<string, KlientZEnv>();
  if (env.OIDC_REZERVACE_SECRET)
    mapa.set('rezervace', { client_id: 'rezervace', client_secret: env.OIDC_REZERVACE_SECRET });
  if (env.OIDC_EKNIHY_SECRET)
    mapa.set('eknihy', { client_id: 'eknihy', client_secret: env.OIDC_EKNIHY_SECRET });
  if (env.OIDC_KLIENTI) {
    let pole: unknown;
    try {
      pole = JSON.parse(env.OIDC_KLIENTI);
    } catch {
      throw new Error('OIDC_KLIENTI není platný JSON');
    }
    if (!Array.isArray(pole)) throw new Error('OIDC_KLIENTI musí být JSON pole');
    for (const k of pole as KlientZEnv[]) {
      if (!k?.client_id || typeof k.client_secret !== 'string' || k.client_secret.length < 16)
        throw new Error('OIDC_KLIENTI: každý klient potřebuje client_id a client_secret (min. 16 znaků)');
      if (k.client_id === PLATFORMA_CLIENT_ID) throw new Error('OIDC_KLIENTI: id „platforma“ je vyhrazené');
      mapa.set(k.client_id, k);
    }
  }
  return [...mapa.values()];
}

export async function zajistiKlientyAplikaci(db: Db, env: Env): Promise<string[]> {
  const ids: string[] = [];
  for (const k of klientiZEnv(env)) {
    const app = APLIKACE[k.client_id];
    const cesta = app?.cesta ?? `/${k.client_id}`;
    const radek = {
      client_id: k.client_id,
      client_secret: k.client_secret,
      nazev: k.nazev ?? app?.nazev ?? k.client_id,
      redirect_uris: k.redirect_uris ?? [`${env.BASE_URL}${cesta}/prihlaseni/callback`],
      post_logout_redirect_uris: k.post_logout_redirect_uris ?? [`${env.BASE_URL}/`],
      auth_metoda: k.auth_metoda === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
      duveryhodny: true,
      aktivni: true,
    };
    await db
      .insertInto('oidc_klienti')
      .values(radek)
      .onConflict((oc) => oc.column('client_id').doUpdateSet(radek))
      .execute();
    ids.push(k.client_id);
  }
  return ids;
}

function htmlStranka(nadpis: string, telo: string, obec: string): string {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${nadpis} — ${obec}</title><link rel="stylesheet" href="/static/css/ramec.css"><link rel="stylesheet" href="/static/css/styl.css"></head><body><header class="hlavicka"><div class="obal"><a class="znacka" href="/">${obec}</a></div></header><main id="obsah" class="obal"><h1>${nadpis}</h1>${telo}</main></body></html>`;
}

export async function vytvorProvider(db: Db, env: Env, obec: ObecProfil): Promise<Provider> {
  const issuer = `${env.BASE_URL}${OIDC_PREFIX}`;
  const jwks = await nactiNeboVytvorJwks(db);
  const obecNazev = obec.obec.nazev.replace(/[<>&"]/g, '');

  const konfigurace: Configuration = {
    adapter: vytvorAdapter(db),
    jwks,
    cookies: {
      keys: [env.OIDC_COOKIE_SECRET],
      long: { signed: true, httpOnly: true, sameSite: 'lax', path: '/' },
      short: { signed: true, httpOnly: true, sameSite: 'lax', path: '/' },
      names: { session: 'mo_oidc', interaction: 'mo_oidc_int', resume: 'mo_oidc_res' },
    },
    scopes: [...ROZSAHY],
    claims: {
      openid: ['sub'],
      profile: ['name', 'given_name', 'family_name', 'nickname', 'preferred_username', 'updated_at'],
      email: ['email', 'email_verified'],
      phone: ['phone_number', 'phone_number_verified'],
      obec: ['cast_obce', 'rezident', 'role', 'mujucet_id'],
    },
    pkce: { required: () => true },
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      id_token_signed_response_alg: 'ES256',
      token_endpoint_auth_method: 'client_secret_basic',
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // potvrzení odhlášení — česky; JS jen odesílá formulář automaticky (bez JS zůstává tlačítko)
        logoutSource: async (ctx: KoaContextWithOIDC, form: string) => {
          ctx.body = htmlStranka(
            'Odhlášení',
            `<p>Odhlašujete se ze všech služeb obce.</p>${form.replace('</form>', '<input type="hidden" name="logout" value="yes"><button class="tlacitko" type="submit">Odhlásit</button></form>')}<script>document.forms[0].submit()</script>`,
            obecNazev,
          );
        },
        postLogoutSuccessSource: async (ctx: KoaContextWithOIDC) => {
          ctx.body = htmlStranka('Jste odhlášeni', `<p><a href="/">Zpět na úvod</a></p>`, obecNazev);
        },
      },
    },
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 600,
      IdToken: 3600,
      RefreshToken: 30 * 24 * 3600,
      Session: 30 * 24 * 3600,
      Interaction: 3600,
      Grant: 30 * 24 * 3600,
    },
    interactions: {
      url: (_ctx, interaction) => `${OIDC_PREFIX}/interaction/${interaction.uid}`,
    },
    // Vlastní moduly platformy (duveryhodny=true) nepotřebují obrazovku souhlasu — grant vznikne sám.
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId || ctx.oidc.session?.grantIdFor(ctx.oidc.client!.clientId);
      if (grantId) {
        const grant = await ctx.oidc.provider.Grant.find(grantId);
        if (grant) return grant;
      }
      const klient = await db
        .selectFrom('oidc_klienti')
        .select('duveryhodny')
        .where('client_id', '=', ctx.oidc.client!.clientId)
        .executeTakeFirst();
      if (!klient?.duveryhodny || !ctx.oidc.session?.accountId) return undefined;
      const grant = new ctx.oidc.provider.Grant({
        clientId: ctx.oidc.client!.clientId,
        accountId: ctx.oidc.session.accountId,
      });
      grant.addOIDCScope(ctx.oidc.params?.scope ? String(ctx.oidc.params.scope) : 'openid');
      await grant.save();
      return grant;
    },
    findAccount: async (_ctx, sub) => {
      const u = await db.selectFrom('uzivatele').selectAll().where('id', '=', sub).executeTakeFirst();
      if (!u || u.blokovan_at) return undefined;
      return {
        accountId: u.id,
        async claims() {
          return {
            sub: u.id,
            name: celeJmeno(u),
            given_name: u.jmeno || undefined,
            family_name: u.prijmeni || undefined,
            nickname: u.prezdivka || undefined,
            preferred_username: u.prezdivka || celeJmeno(u),
            updated_at: Math.floor(u.upraven_at.getTime() / 1000),
            email: u.email ?? undefined,
            email_verified: !!u.email_overen_at,
            phone_number: u.telefon,
            phone_number_verified: !!u.telefon_overen_at,
            cast_obce: u.cast_obce,
            rezident: u.rezident,
            role: u.role,
            mujucet_id: u.cislo,
          };
        },
      };
    },
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      ctx.body = htmlStranka(
        'Přihlášení se nezdařilo',
        `<p>${String(out.error_description ?? out.error ?? '').replace(/[<>&]/g, '')}</p><p><a href="/">Zpět na úvod</a></p>`,
        obecNazev,
      );
    },
  };

  const provider = new Provider(issuer, konfigurace);
  provider.proxy = true; // za reverzní proxy (NPM/Caddy) — X-Forwarded-Proto rozhoduje o secure cookies
  return provider;
}
