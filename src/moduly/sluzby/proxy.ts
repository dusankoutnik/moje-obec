// Proxy aplikací obce pod cestou na doméně platformy: /rezervace/* → APLIKACE_REZERVACE_URL, /eknihy/* →
// APLIKACE_EKNIHY_URL. Běží v háčku onRequest PŘED sezením platformy: tělo požadavku se nečte ani neparsuje (formuláře,
// multipart jdou beze změny), nevzniká sezení ani CSRF platformy a odpověď aplikace se posílá 1:1 (Set-Cookie,
// Location, vlastní CSP) — háčky onSend platformy (bezpečnostní hlavičky) se na ni nevztahují (reply.hijack).
// Cesta se předává celá včetně předpony; aplikace o ní ví z X-Forwarded-Prefix (rezervace BASE_PATH, eKnihy ProxyFix).
import http from 'node:http';
import https from 'node:https';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { podCestou, type KlicModulu, type ModulySluzba } from './sluzba.js';

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

export function zaregistrujProxy(
  app: FastifyInstance,
  moduly: ModulySluzba,
  stranky: {
    vypnuto: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    nedostupne: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  },
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
    await predej(req, reply, c, url);
  });

  // trasy jen kvůli směrování (bez nich by Fastify požadavek poslal do 404); obslouží je háček výše
  for (const c of cile) {
    const nic = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(404).send();
    app.all(c.prefix, nic);
    app.all(c.prefix + '/*', nic);
  }

  function predej(req: FastifyRequest, reply: FastifyReply, c: CilProxy, url: string): Promise<unknown> {
    return new Promise((hotovo) => {
      const hlavicky: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP.has(k) || k.startsWith('x-forwarded-')) continue;
        hlavicky[k] = v;
      }
      const host = req.headers.host ?? new URL(app.env.BASE_URL).host;
      hlavicky.host = host;
      hlavicky['x-forwarded-host'] = host;
      hlavicky['x-forwarded-proto'] = proto;
      // jen skutečná IP klienta (podle TRUST_PROXY_HOPS) — aplikace za jednou proxy si vezme poslední položku
      hlavicky['x-forwarded-for'] = req.ip;
      hlavicky['x-forwarded-prefix'] = c.prefix;
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
