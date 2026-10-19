// Zdvořilé stahování ze starého webu obce: identifikující User-Agent, nejvýš N požadavků za sekundu,
// opakování při chybě 429/5xx, limit celkové velikosti stažených souborů.
//
// Bezpečnost (import běží vedle databáze a interních služeb): jen http(s); přesměrování se sledují ručně
// (nejvýš MAX_SKOKU) a každý cíl se znovu ověří; adresy, které vedou do neveřejné sítě (loopback, privátní
// rozsahy, link-local včetně metadat cloudu…), se odmítnou až PO překladu DNS — připojení jde přesně na
// ověřenou adresu (vlastní `lookup`), takže je neobejde ani DNS, které mezitím odpoví jinak. Tělo odpovědi
// se čte proudem s počítadlem (i po rozbalení gzip/br) a nad limit se spojení utne; Content-Length nad limit
// se odmítne rovnou. Každý požadavek má časový limit nečinnosti i celkový.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Stahovac } from './typy.js';

export interface VolbyStahovace {
  userAgent: string;
  /** nejkratší rozestup požadavků v ms (500 = 2 požadavky/s) */
  rozestupMs?: number;
  /** strop pro soubory celkem (bajty) — nad ním soubor() vrací null */
  limitBajtu?: number;
  /** strop pro jeden soubor (bajty), výchozí 300 MB (víc nepřijme ani úložiště videí) */
  maxBajtuSouboru?: number;
  /** strop pro stránku nebo JSON (bajty), výchozí 20 MB */
  maxBajtuTextu?: number;
  /** čas bez přijatých dat, po kterém se požadavek vzdá (ms), výchozí 30 s */
  timeoutMs?: number;
  /** celkový čas na jeden požadavek včetně těla (ms), výchozí 10 min */
  celkovyTimeoutMs?: number;
  /** pauza před opakováním (násobí se číslem pokusu), výchozí 2 s */
  pauzaMs?: number;
  /**
   * Původy (např. `http://127.0.0.1:8080`), u kterých se nekontroluje, zda vedou do neveřejné sítě —
   * jen pro testy a import z lokální kopie webu. Přesměrování jinam se kontroluje vždy.
   */
  povolenePuvody?: string[];
  log?: (zprava: string) => void;
}

export const MAX_SKOKU = 5;

/** chyba stahování; `docasna` = má smysl zkusit znovu (síť, časový limit) */
export class ChybaStahovani extends Error {
  constructor(
    zprava: string,
    readonly docasna = false,
  ) {
    super(zprava);
  }
}

// rozsahy, kam import nikdy nesmí (RFC 6890 a spol.): loopback, privátní sítě, link-local (169.254.169.254 =
// metadata cloudu), sdílený prostor operátorů, dokumentační, multicast a rezervované adresy
// (dva oddělené seznamy: BlockList by IPv4 adresu porovnal i s IPv6 pravidly přes ::ffff:0:0/96)
const NEVEREJNE_V4 = new net.BlockList();
const NEVEREJNE_V6 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NEVEREJNE_V4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 96], // nespecifikovaná, loopback a zastaralé „IPv4-compatible“
  ['::ffff:0:0', 96], // IPv4 namapovaná do IPv6
  ['64:ff9b::', 96], // NAT64 (vede na libovolnou IPv4)
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 (vložená IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  NEVEREJNE_V6.addSubnet(a, p, 'ipv6');

/** je IP adresa veřejná (smí na ni import)? Neplatná adresa = ne. */
export function jeVerejnaAdresa(ip: string): boolean {
  const verze = net.isIP(ip);
  if (!verze) return false;
  return verze === 4 ? !NEVEREJNE_V4.check(ip, 'ipv4') : !NEVEREJNE_V6.check(ip, 'ipv6');
}

// překlad jména s kontrolou: připojí se jen na ověřené adresy (žádná druhá, jiná odpověď DNS)
const bezpecnyLookup = ((
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void,
) => {
  dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, adresy) => {
    if (err) return callback(err);
    if (!adresy.length || adresy.some((a) => !jeVerejnaAdresa(a.address)))
      return callback(new ChybaStahovani(`${hostname} vede do neveřejné sítě — odmítnuto`));
    if (options.all) callback(null, adresy);
    else callback(null, adresy[0]!.address, adresy[0]!.family);
  });
}) as unknown as net.LookupFunction;

interface Odpoved {
  status: number;
  hlavicky: Headers;
  data: Buffer;
  presmerovani: string | null;
}

/** úspěšná odpověď, ale tělo je nad limit (nemá smysl opakovat) */
class ChybaVelikosti extends ChybaStahovani {}

export function vytvorStahovac(v: VolbyStahovace): Stahovac {
  const rozestup = v.rozestupMs ?? 500;
  const maxSouboru = v.maxBajtuSouboru ?? 300 * 1024 * 1024;
  const maxTextu = v.maxBajtuTextu ?? 20 * 1024 * 1024;
  const timeout = v.timeoutMs ?? 30_000;
  const celkovy = v.celkovyTimeoutMs ?? 600_000;
  const pauza = v.pauzaMs ?? 2000;
  const povolene = new Set((v.povolenePuvody ?? []).map((p) => new URL(p).origin));
  for (const [n, x] of Object.entries({ rozestup, maxSouboru, maxTextu, timeout, celkovy, pauza }))
    if (!Number.isFinite(x) || x < 0) throw new Error(`stahovač: neplatná hodnota ${n}`);
  if (v.limitBajtu !== undefined && (!Number.isFinite(v.limitBajtu) || v.limitBajtu <= 0))
    throw new Error('stahovač: neplatný limit velikosti');
  let posledni = 0;
  let stazeno = 0;
  const pockej = async (ms: number) => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  };
  const dalsiNaRade = async () => {
    const ted = Date.now();
    const cekat = posledni + rozestup - ted;
    posledni = Math.max(ted, posledni + rozestup);
    await pockej(cekat);
  };

  /** jeden HTTP požadavek bez sledování přesměrování; tělo nejvýš `maxBajtu` */
  function pozadavek(url: URL, maxBajtu: number): Promise<Odpoved> {
    const verejna = !povolene.has(url.origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (verejna && net.isIP(host) && !jeVerejnaAdresa(host))
      return Promise.reject(new ChybaStahovani(`${url.host} je neveřejná adresa — odmítnuto`));
    return new Promise<Odpoved>((resolve, reject) => {
      let hotovo = false;
      const konec = (e: Error | null, o?: Odpoved) => {
        if (hotovo) return;
        hotovo = true;
        if (e) reject(e);
        else resolve(o!);
      };
      const modul = url.protocol === 'https:' ? https : http;
      const req = modul.request(url, {
        method: 'GET',
        headers: { 'user-agent': v.userAgent, accept: '*/*', 'accept-encoding': 'gzip, deflate, br' },
        lookup: verejna ? bezpecnyLookup : undefined,
        signal: AbortSignal.timeout(celkovy),
        timeout,
      });
      req.on('timeout', () => req.destroy(new ChybaStahovani(`vypršel čas: ${url.href}`, true)));
      req.on('error', (e) =>
        konec(
          e instanceof ChybaStahovani
            ? e
            : new ChybaStahovani(
                e.name === 'AbortError' || e.name === 'TimeoutError'
                  ? `vypršel čas: ${url.href}`
                  : `chyba sítě ${url.href}: ${e.message}`,
                true,
              ),
        ),
      );
      req.on('response', (res) => {
        const hlavicky = new Headers();
        for (const [k, h] of Object.entries(res.headers))
          for (const x of Array.isArray(h) ? h : h === undefined ? [] : [h]) hlavicky.append(k, x);
        const status = res.statusCode ?? 0;
        const misto = res.headers.location;
        if (status >= 300 && status < 400 && misto) {
          res.resume();
          return konec(null, { status, hlavicky, data: Buffer.alloc(0), presmerovani: misto });
        }
        if (status < 200 || status >= 300) {
          // tělo chybové odpovědi nepotřebujeme
          req.destroy();
          return konec(null, { status, hlavicky, data: Buffer.alloc(0), presmerovani: null });
        }
        const delka = Number(res.headers['content-length']);
        if (Number.isFinite(delka) && delka > maxBajtu) {
          req.destroy();
          return konec(new ChybaVelikosti(`soubor je větší než povolený limit: ${url.href}`));
        }
        const kodovani = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let proud: Readable = res;
        if (kodovani === 'gzip' || kodovani === 'x-gzip') proud = res.pipe(zlib.createGunzip());
        else if (kodovani === 'deflate') proud = res.pipe(zlib.createInflate());
        else if (kodovani === 'br') proud = res.pipe(zlib.createBrotliDecompress());
        const kusy: Buffer[] = [];
        let celkem = 0;
        proud.on('data', (kus: Buffer) => {
          celkem += kus.length;
          if (celkem > maxBajtu) {
            proud.destroy();
            req.destroy();
            konec(new ChybaVelikosti(`soubor je větší než povolený limit: ${url.href}`));
            return;
          }
          kusy.push(kus);
        });
        proud.on('error', (e) =>
          konec(new ChybaStahovani(`chyba při čtení ${url.href}: ${e.message}`, true)),
        );
        res.on('error', (e) => konec(new ChybaStahovani(`chyba při čtení ${url.href}: ${e.message}`, true)));
        proud.on('end', () =>
          konec(null, { status, hlavicky, data: Buffer.concat(kusy), presmerovani: null }),
        );
      });
      req.end();
    });
  }

  /** požadavek se sledováním přesměrování (každý cíl znovu ověřen) */
  async function sPresmerovanim(adresa: string, maxBajtu: number): Promise<Odpoved> {
    let url: URL;
    try {
      url = new URL(adresa);
    } catch {
      throw new ChybaStahovani(`neplatná adresa: ${adresa}`);
    }
    for (let skok = 0; ; skok++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new ChybaStahovani(`nepodporovaný protokol: ${url.protocol}`);
      const o = await pozadavek(url, maxBajtu);
      if (!o.presmerovani) return o;
      if (skok >= MAX_SKOKU) throw new ChybaStahovani(`příliš mnoho přesměrování: ${adresa}`);
      try {
        url = new URL(o.presmerovani, url);
      } catch {
        throw new ChybaStahovani(`neplatné přesměrování z ${url.href}`);
      }
    }
  }

  async function ziskej(url: string, maxBajtu: number): Promise<Odpoved> {
    for (let pokus = 1; pokus <= 4; pokus++) {
      await dalsiNaRade();
      try {
        const res = await sPresmerovanim(url, maxBajtu);
        if (res.status === 429 || res.status >= 500) {
          v.log?.(`${res.status} ${url} — zkusím znovu`);
          const za = Number(res.hlavicky.get('retry-after'));
          await pockej(Number.isFinite(za) && za > 0 ? Math.min(za * 1000, 60_000) : pauza * pokus);
          continue;
        }
        return res;
      } catch (e) {
        if (!(e instanceof ChybaStahovani) || !e.docasna) throw e;
        v.log?.(e.message);
        await pockej(pauza * pokus);
      }
    }
    throw new ChybaStahovani(`Nepodařilo se stáhnout ${url}`, true);
  }

  const ok = (r: Odpoved, url: string) => {
    if (r.status < 200 || r.status >= 300) throw new ChybaStahovani(`${r.status} ${url}`);
    return r;
  };
  return {
    get stazeno() {
      return stazeno;
    },
    async text(url) {
      return ok(await ziskej(url, maxTextu), url).data.toString('utf8');
    },
    async json<T = unknown>(url: string) {
      const r = ok(await ziskej(url, maxTextu), url);
      return { data: JSON.parse(r.data.toString('utf8')) as T, hlavicky: r.hlavicky };
    },
    async soubor(url) {
      const zbyva = v.limitBajtu ? v.limitBajtu - stazeno : Infinity;
      if (zbyva <= 0) return null;
      let r: Odpoved | null;
      try {
        r = await ziskej(url, Math.min(maxSouboru, zbyva));
      } catch (e) {
        v.log?.(`soubor nestažen (${(e as Error).message})`);
        return null;
      }
      if (r.status < 200 || r.status >= 300) {
        v.log?.(`soubor nedostupný (${r.status}): ${url}`);
        return null;
      }
      stazeno += r.data.length;
      return { data: r.data, typ: r.hlavicky.get('content-type') ?? '' };
    },
  };
}

/** číselná volba příkazové řádky: chybí → výchozí; nečíselná, záporná nebo nekonečná → chyba */
export function cisloVolby(hodnota: string | undefined, vychozi: number, nazev: string): number {
  if (hodnota === undefined) return vychozi;
  const n = Number(hodnota);
  if (hodnota.trim() === '' || !Number.isFinite(n) || n < 0)
    throw new Error(`Volba --${nazev}: „${hodnota}“ není nezáporné číslo`);
  return n;
}
