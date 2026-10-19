// Společné HTTP volání SMS bran: časový limit (zaseknutá brána nesmí zablokovat frontu ani přihlašování),
// rozlišení dočasných chyb (opakovat) od trvalých a hlavička Retry-After.
import { SmsChyba } from './typy.js';

/** výchozí časový limit jednoho požadavku na bránu */
export const SMS_TIMEOUT_MS = 10_000;

export interface OdpovedBrany {
  status: number;
  ok: boolean;
  text: string;
  /** za kolik ms zkusit znovu (Retry-After), pokud ji brána poslala */
  zkusitZaMs?: number;
}

/** HTTP stavy, po kterých má smysl to zkusit znovu */
export function jeDocasnyStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Retry-After: počet sekund nebo HTTP datum → ms (nejvýš hodina) */
export function retryAfterMs(hodnota: string | null, ted = Date.now()): number | undefined {
  if (!hodnota) return undefined;
  const s = hodnota.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const d = Date.parse(s);
    if (!Number.isNaN(d)) ms = Math.max(0, d - ted);
  }
  return ms === undefined ? undefined : Math.min(ms, 3600_000);
}

/**
 * Jeden požadavek na bránu včetně načtení těla, celé pod časovým limitem.
 * Síťová chyba nebo vypršení limitu = dočasná SmsChyba (fronta to zkusí znovu).
 */
export async function volejBranu(
  f: typeof fetch,
  nazev: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = SMS_TIMEOUT_MS,
): Promise<OdpovedBrany> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, zkusitZaMs: retryAfterMs(res.headers.get('retry-after')) };
  } catch (e) {
    const err = e as Error;
    const limit = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new SmsChyba(
      limit
        ? `${nazev}: brána neodpověděla do ${Math.round(timeoutMs / 1000)} s`
        : `${nazev}: síťová chyba (${err.message})`,
      true,
    );
  }
}

/** chybová odpověď brány → SmsChyba (dočasná podle HTTP stavu, s Retry-After) */
export function chybaOdpovedi(nazev: string, o: OdpovedBrany): SmsChyba {
  return new SmsChyba(
    `${nazev} ${o.status}: ${o.text.slice(0, 200)}`,
    jeDocasnyStatus(o.status),
    o.zkusitZaMs,
  );
}

export function jsonZ<T>(o: OdpovedBrany): T | null {
  try {
    return JSON.parse(o.text) as T;
  } catch {
    return null;
  }
}
