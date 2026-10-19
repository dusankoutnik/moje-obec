// Platforma jako OIDC klient vlastního providera (openid-client). Díky tomu se interní moduly přihlašují
// úplně stejně jako externí aplikace — žádná zkratka, žádná domácí cookie napříč aplikacemi.
import * as oc from 'openid-client';
import type { Env } from '../../../config/env.js';
import { OIDC_PREFIX, PLATFORMA_CLIENT_ID } from './provider.js';

export interface OidcKlient {
  config: oc.Configuration;
  issuer: string;
  callbackUrl: string;
  zacniPrihlaseni(): { url: string; state: string; nonce: string; verifier: string };
  dokonciPrihlaseni(
    aktualniUrl: URL,
    ulozeno: { state: string; nonce: string; verifier: string },
  ): Promise<{ sub: string; idToken: string | undefined; claims: Record<string, unknown> }>;
  odhlasovaciUrl(idToken: string | undefined): string;
}

export function vytvorOidcKlienta(env: Env): OidcKlient {
  const issuer = `${env.BASE_URL}${OIDC_PREFIX}`;
  const callbackUrl = `${env.BASE_URL}/prihlaseni/callback`;
  const server: oc.ServerMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/me`,
    end_session_endpoint: `${issuer}/session/end`,
  };
  const config = new oc.Configuration(
    server,
    PLATFORMA_CLIENT_ID,
    { client_secret: env.OIDC_PLATFORMA_SECRET, id_token_signed_response_alg: 'ES256' },
    oc.ClientSecretBasic(env.OIDC_PLATFORMA_SECRET),
  );
  if (!issuer.startsWith('https://')) oc.allowInsecureRequests(config);

  // Volání sebe sama (token endpoint, JWKS) jde po vnitřní adrese — ne přes veřejnou proxy (ta může mít HTTP heslo, TLS, …).
  const interni = (env.INTERNAL_BASE_URL ?? '').replace(/\/$/, '');
  if (interni && interni !== env.BASE_URL) {
    config[oc.customFetch] = (url, options) =>
      fetch(String(url).replace(env.BASE_URL, interni), options as RequestInit);
  }

  return {
    config,
    issuer,
    callbackUrl,
    zacniPrihlaseni() {
      const verifier = oc.randomPKCECodeVerifier();
      const state = oc.randomState();
      const nonce = oc.randomNonce();
      return { url: '', state, nonce, verifier };
    },
    async dokonciPrihlaseni(aktualniUrl, ulozeno) {
      const tokeny = await oc.authorizationCodeGrant(config, aktualniUrl, {
        pkceCodeVerifier: ulozeno.verifier,
        expectedState: ulozeno.state,
        expectedNonce: ulozeno.nonce,
        idTokenExpected: true,
      });
      const claims = tokeny.claims();
      if (!claims) throw new Error('ID token chybí');
      return { sub: String(claims.sub), idToken: tokeny.id_token, claims: claims as Record<string, unknown> };
    },
    odhlasovaciUrl(idToken) {
      const params: Record<string, string> = { post_logout_redirect_uri: `${env.BASE_URL}/` };
      if (idToken) params.id_token_hint = idToken;
      return oc.buildEndSessionUrl(config, params).href;
    },
  };
}

// sestaví autorizační URL (zvlášť, protože potřebuje state/nonce/verifier uložené v sezení)
export async function autorizacniUrl(
  klient: OidcKlient,
  s: { state: string; nonce: string; verifier: string },
): Promise<string> {
  const challenge = await oc.calculatePKCECodeChallenge(s.verifier);
  return oc.buildAuthorizationUrl(klient.config, {
    redirect_uri: klient.callbackUrl,
    scope: 'openid profile email phone obec',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: s.state,
    nonce: s.nonce,
  }).href;
}
