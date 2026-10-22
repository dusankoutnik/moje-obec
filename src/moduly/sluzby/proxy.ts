// Proxy aplikací obce pod cestou na doméně platformy: /rezervace/* → APLIKACE_REZERVACE_URL, /eknihy/* →
// APLIKACE_EKNIHY_URL. Běží v háčku onRequest PŘED sezením platformy: tělo požadavku se nečte ani neparsuje (formuláře,
// multipart jdou beze změny), nevzniká sezení ani CSRF platformy a odpověď aplikace se posílá 1:1 (Set-Cookie,
// Location, vlastní CSP) — háčky onSend platformy (bezpečnostní hlavičky) se na ni nevztahují (reply.hijack).
// Cesta se předává celá včetně předpony; aplikace o ní ví z X-Forwarded-Prefix (rezervace BASE_PATH, eKnihy ProxyFix).
import http from 'node:http';
import https from 'node:https';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { podCestou, type KlicModulu, type ModulySluzba } from './sluzba.js';
import type { Db } from '../../db/index.js';

export interface CilProxy {
  /** modul (rezervace, eknihy) */
  klic: KlicModulu;
  prefix: string;
  cil: URL;
}

// hlavičky, které platí jen pro jedno spojení — dál se nepředávají (RFC 9110 7.6.1)
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });

export function cileProxy(env: {
  APLIKACE_REZERVACE_URL?: string | undefined;
  APLIKACE_EKNIHY_URL?: string | undefined;
}): CilProxy[] {
  const c: CilProxy[] = [];
  if (env.APLIKACE_REZERVACE_URL)
    c.push({ klic: 'rezervace', prefix: '/rezervace', cil: new URL(env.APLIKACE_REZERVACE_URL) });
  if (env.APLIKACE_EKNIHY_URL)
    c.push({ klic: 'eknihy', prefix: '/eknihy', cil: new URL(env.APLIKACE_EKNIHY_URL) });
  return c;
}

/** Location z aplikace: absolutní adresa na vnitřní cíl → relativní (prohlížeč vnitřní adresu nezná) */
export function prepisLocation(loc: string, cil: URL): string {
  if (/^https?:\/\//i.test(loc)) {
    try {
      const u = new URL(loc);
      if (u.host === cil.host) return u.pathname + u.search + u.hash;
    } catch {
      /* neplatná adresa — nechat být */
    }
  }
  return loc;
}

/** číslo účtu přihlášeného na platformě (pro aplikace za proxy); null = nikdo */
export type Prihlaseny = (req: FastifyRequest) => Promise<string | null>;

// Jednotné přihlášení (2026-10-22): proxy běží před sezením platformy, cookie sezení si proto přečte sama (podpis
// @fastify/cookie, tabulka sezeni) a aplikacím posílá u stránek hlavičku X-Platforma-Uzivatel — číslo účtu, nebo
// prázdné (na webu nikdo přihlášen). Aplikace se podle ní tiše přihlásí přes OIDC, nebo naopak zruší své sezení.
export function prihlasenyZeSezeni(db: Db, secret: string, cookieName = 'mo_sezeni'): Prihlaseny {
  const signer = new fastifyCookie.Signer(secret);
  const kes = new Map<string, { do: number; cislo: string | null }>();
  return async (req) => {
    const polozka = (req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + '='));
    if (!polozka) return null;
    let hodnota = polozka.slice(cookieName.length + 1);
    try {
      hodnota = decodeURIComponent(hodnota);
    } catch {
      return null;
    }
    const u = signer.unsign(hodnota);
    if (!u.valid || !u.value) return null;
    const sid = u.value;
    const k = kes.get(sid);
    if (k && k.do > Date.now()) return k.cislo;
    let cislo: string | null = null;
    const r = await db
      .selectFrom('sezeni')
      .select(['data', 'expires_at'])
      .where('sid', '=', sid)
      .executeTakeFirst();
    const id =
      r && r.expires_at > new Date() ? (r.data as unknown as { uzivatelId?: string }).uzivatelId : undefined;
    if (id) {
      const uz = await db
        .selectFrom('uzivatele')
        .select(['cislo', 'blokovan_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (uz && !uz.blokovan_at && uz.cislo != null) cislo = String(uz.cislo);
    }
    if (kes.size > 1000) kes.clear();
    kes.set(sid, { do: Date.now() + 15_000, cislo });
    return cislo;
  };
}

export function zaregistrujProxy(
  app: FastifyInstance,
  moduly: ModulySluzba,
  stranky: {
    vypnuto: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    nedostupne: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  },
  prihlaseny?: Prihlaseny,
) {
  const cile = cileProxy(app.env);
  if (!cile.length) return;
  const proto = app.env.BASE_URL.startsWith('https://') ? 'https' : 'http';
  const timeout = app.env.APLIKACE_TIMEOUT_MS;

  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '/';
    const cesta = url.split('?')[0]!;
    const c = cile.find((x) => podCestou(cesta, x.prefix));
    if (!c) return;
    // modul vypnutý (nebo jeho část — předprodej, spolujízda) → stránka platformy
    const stav = await moduly.stav();
    if (!stav[c.klic]) return stranky.vypnuto(req, reply);
    if (c.klic === 'rezervace') {
      for (const cast of ['predprodej', 'spolujizda'] as const)
        if (!stav[cast] && podCestou(cesta, moduly.popis(cast).cesty[0]!)) return stranky.vypnuto(req, reply);
    }
    // /rezervace → /rezervace/ (relativní odkazy aplikace)
    if (cesta === c.prefix) {
      const dotaz = url.slice(cesta.length);
      return reply
        .code(301)
        .header('location', c.prefix + '/' + dotaz)
        .send();
    }
    // jednotné přihlášení: u stránek (GET s Accept text/html) říct aplikaci, kdo je na platformě přihlášen
    let prihlasen: string | undefined;
    if (
      prihlaseny &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      /text\/html/i.test(String(req.headers.accept ?? ''))
    ) {
      try {
        prihlasen = (await prihlaseny(req)) ?? '';
      } catch (e) {
        req.log.warn({ err: e }, 'proxy: sezení platformy se nepodařilo přečíst');
      }
    }
    await predej(req, reply, c, url, prihlasen);
  });

  // trasy jen kvůli směrování (bez nich by Fastify požadavek poslal do 404); obslouží je háček výše
  for (const c of cile) {
    const nic = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send();
    app.all(c.prefix, nic);
    app.all(c.prefix + '/*', nic);
  }

  function predej(
    req: FastifyRequest,
    reply: FastifyReply,
    c: CilProxy,
    url: string,
    prihlasen?: string,
  ): Promise<unknown> {
    return new Promise((hotovo) => {
      const hlavicky: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP.has(k) || k.startsWith('x-forwarded-') || k === 'x-platforma-uzivatel')
          continue;
        hlavicky[k] = v;
      }
      const host = req.headers.host ?? new URL(app.env.BASE_URL).host;
      hlavicky.host = host;
      hlavicky['x-forwarded-host'] = host;
      hlavicky['x-forwarded-proto'] = proto;
      // jen skutečná IP klienta (podle TRUST_PROXY_HOPS) — aplikace za jednou proxy si vezme poslední položku
      hlavicky['x-forwarded-for'] = req.ip;
      hlavicky['x-forwarded-prefix'] = c.prefix;
      if (prihlasen !== undefined) hlavicky['x-platforma-uzivatel'] = prihlasen;
      const modul = c.cil.protocol === 'https:' ? https : http;
      let odeslano = false;
      const upstream = modul.request(
        {
          protocol: c.cil.protocol,
          hostname: c.cil.hostname,
          port: c.cil.port || undefined,
          method: req.method,
          path: url,
          headers: hlavicky,
          agent: c.cil.protocol === 'https:' ? agentHttps : agentHttp,
        },
        (res) => {
          odeslano = true;
          reply.hijack();
          const ven: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined || HOP.has(k)) continue;
            ven[k] = k === 'location' && typeof v === 'string' ? prepisLocation(v, c.cil) : v;
          }
          reply.raw.writeHead(res.statusCode ?? 502, res.statusMessage, ven);
          res.pipe(reply.raw);
          res.on('error', () => reply.raw.destroy());
          res.on('end', () => hotovo(undefined));
          reply.raw.on('close', () => {
            if (!res.complete) res.destroy();
            hotovo(undefined);
          });
        },
      );
      upstream.setTimeout(timeout, () => upstream.destroy(new Error('timeout')));
      upstream.on('error', (e) => {
        if (odeslano) {
          reply.raw.destroy();
          return hotovo(undefined);
        }
        odeslano = true;
        req.log.warn({ err: e, cil: c.cil.origin, modul: c.klic }, 'proxy: aplikace neodpovídá');
        // zbytek těla klienta zahodit, ať spojení neuvízne
        req.raw.resume();
        hotovo(stranky.nedostupne(req, reply));
      });
      req.raw.on('aborted', () => upstream.destroy());
      req.raw.pipe(upstream);
    });
  }
}
