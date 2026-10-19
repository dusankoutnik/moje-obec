// Zdvořilé stahování ze starého webu obce: identifikující User-Agent, nejvýš N požadavků za sekundu,
// opakování při chybě 429/5xx, limit celkové velikosti stažených souborů.
import type { Stahovac } from './typy.js';

export interface VolbyStahovace {
  userAgent: string;
  /** nejkratší rozestup požadavků v ms (500 = 2 požadavky/s) */
  rozestupMs?: number;
  /** strop pro soubory (bajty) — nad ním soubor() vrací null */
  limitBajtu?: number;
  maxSouboru?: number;
  log?: (zprava: string) => void;
}

export function vytvorStahovac(v: VolbyStahovace): Stahovac {
  const rozestup = v.rozestupMs ?? 500;
  let posledni = 0;
  let stazeno = 0;
  const pockej = async () => {
    const ted = Date.now();
    const cekat = posledni + rozestup - ted;
    posledni = Math.max(ted, posledni + rozestup);
    if (cekat > 0) await new Promise((r) => setTimeout(r, cekat));
  };
  async function ziskej(url: string): Promise<Response> {
    for (let pokus = 1; pokus <= 4; pokus++) {
      await pockej();
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': v.userAgent, accept: '*/*' },
          redirect: 'follow',
        });
        if (res.status === 429 || res.status >= 500) {
          v.log?.(`${res.status} ${url} — zkusím znovu`);
          await new Promise((r) => setTimeout(r, 2000 * pokus));
          continue;
        }
        return res;
      } catch (e) {
        v.log?.(`chyba sítě ${url}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000 * pokus));
      }
    }
    throw new Error(`Nepodařilo se stáhnout ${url}`);
  }
  return {
    get stazeno() {
      return stazeno;
    },
    async text(url) {
      const r = await ziskej(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.text();
    },
    async json<T = unknown>(url: string) {
      const r = await ziskej(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return { data: (await r.json()) as T, hlavicky: r.headers };
    },
    async soubor(url) {
      if (v.limitBajtu && stazeno >= v.limitBajtu) return null;
      const r = await ziskej(url).catch(() => null);
      if (!r || !r.ok) {
        v.log?.(`soubor nedostupný (${r?.status ?? 'síť'}): ${url}`);
        return null;
      }
      const data = Buffer.from(await r.arrayBuffer());
      stazeno += data.length;
      return { data, typ: r.headers.get('content-type') ?? '' };
    },
  };
}
