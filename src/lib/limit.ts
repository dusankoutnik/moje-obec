// Omezení počtu požadavků podle IP (posuvné okno v paměti procesu).
// Doplňuje limit na kontakt v OtpSluzba: brání rozesílání kódů na cizí čísla, výčtu kontaktů
// a hádání hesel z jedné adresy. Jedna instance aplikace → paměť stačí; při více instancích přesunout do DB.
import { isIPv6 } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Klíč limitu z IP adresy. IPv6 se bere po celé síti /64 — domácnost i útočník běžně dostanou /64
 * a jinak by každá adresa z ní měla vlastní limit. IPv4 namapovaná do IPv6 (::ffff:1.2.3.4) = IPv4.
 */
export function klicIp(ip: string): string {
  const s = String(ip ?? '').trim();
  const mapovana = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapovana) return mapovana[1]!;
  if (!isIPv6(s)) return s;
  const bezZony = s.split('%')[0]!;
  const [hlava = '', pata = ''] = bezZony.split('::');
  const h = hlava ? hlava.split(':') : [];
  const p = pata ? pata.split(':') : [];
  // vložená IPv4 na konci (např. 64:ff9b::1.2.3.4) zabírá dvě skupiny
  if (p.length && p.at(-1)!.includes('.')) p.splice(-1, 1, '0', '0');
  if (h.length && h.at(-1)!.includes('.')) h.splice(-1, 1, '0', '0');
  const skupiny = bezZony.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - p.length)).fill('0'), ...p]
    : h;
  return (
    skupiny
      .slice(0, 4)
      .map((g) => (parseInt(g || '0', 16) || 0).toString(16))
      .join(':') + '::/64'
  );
}

export interface Limit {
  /** true = požadavek je v limitu a započítal se */
  zkus(klic: string, ted?: number): boolean;
  reset(): void;
}

export function vytvorLimit(max: number, oknoMin: number): Limit {
  const okno = oknoMin * 60_000;
  const zaznamy = new Map<string, number[]>();
  let posledniUklid = 0;
  return {
    zkus(klic, ted = Date.now()) {
      if (ted - posledniUklid > okno) {
        for (const [k, casy] of zaznamy) if (!casy.some((c) => ted - c < okno)) zaznamy.delete(k);
        posledniUklid = ted;
      }
      const casy = (zaznamy.get(klic) ?? []).filter((c) => ted - c < okno);
      if (casy.length >= max) {
        zaznamy.set(klic, casy);
        return false;
      }
      casy.push(ted);
      zaznamy.set(klic, casy);
      return true;
    },
    reset() {
      zaznamy.clear();
    },
  };
}

/** preHandler: při překročení vrátí 429 s chybovou stránkou */
export function hlidejLimit(limit: Limit) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (limit.zkus(klicIp(req.ip))) return;
    const t = req.server.t;
    return reply
      .code(429)
      .header('retry-after', '900')
      .view('chyba', { status: 429, nadpis: t('app.chyba_429'), text: t('app.chyba_429_text') });
  };
}
