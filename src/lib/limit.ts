// Omezení počtu požadavků podle IP (posuvné okno v paměti procesu).
// Doplňuje limit na kontakt v OtpSluzba: brání rozesílání kódů na cizí čísla, výčtu kontaktů
// a hádání hesel z jedné adresy. Jedna instance aplikace → paměť stačí; při více instancích přesunout do DB.
import type { FastifyReply, FastifyRequest } from 'fastify';

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
    if (limit.zkus(req.ip)) return;
    const t = req.server.t;
    return reply
      .code(429)
      .header('retry-after', '900')
      .view('chyba', { status: 429, nadpis: t('app.chyba_429'), text: t('app.chyba_429_text') });
  };
}
