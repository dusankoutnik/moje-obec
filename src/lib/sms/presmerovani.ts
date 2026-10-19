// Přesměrování SMS pro vývoj/pilot: zprávy pro vybraná čísla jdou SKUTEČNOU bránou na jiné číslo
// (např. demo správce 777 000 001 → mobil vývojáře), ostatní dál základním poskytovatelem (konzole).
// Kód pro přesměrovaná čísla se na stránce nikdy nezobrazuje (viz zobrazitDevKod).
import type { Env } from '../../config/env.js';
import { normalizujTelefon } from '../kontakty.js';
import type { SmsPoskytovatel, StavDoruceni, VysledekOdeslani } from './typy.js';

/** SMS_PRESMEROVANI="+420777000001>+420777000099, …" → mapa E.164 → E.164 */
export function mapaPresmerovani(env: Pick<Env, 'SMS_PRESMEROVANI'>): Map<string, string> {
  const m = new Map<string, string>();
  for (const par of String(env.SMS_PRESMEROVANI ?? '').split(',')) {
    const [z, na] = par.split('>').map((x) => normalizujTelefon(x?.trim() ?? ''));
    if (z && na) m.set(z, na);
  }
  return m;
}

/** smí se ověřovací kód ukázat na stránce? (jen vývoj a ne u přesměrovaných čísel) */
export function zobrazitDevKod(
  env: Pick<Env, 'OTP_DEV_ZOBRAZIT' | 'SMS_PRESMEROVANI'>,
  telefon: string | null | undefined,
) {
  if (!env.OTP_DEV_ZOBRAZIT) return false;
  const t = normalizujTelefon(telefon ?? '');
  return !(t && mapaPresmerovani(env).has(t));
}

const PREFIX = 'presm:';

export class PresmerovaniSms implements SmsPoskytovatel {
  readonly nazev: string;
  constructor(
    private zaklad: SmsPoskytovatel,
    private skutecny: SmsPoskytovatel,
    private mapa: Map<string, string>,
  ) {
    this.nazev = `${zaklad.nazev}+${skutecny.nazev}`;
  }

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    const cil = this.mapa.get(telefon);
    if (!cil) return this.zaklad.posli(telefon, text);
    const v = await this.skutecny.posli(cil, text);
    return { ...v, branaId: v.branaId ? PREFIX + v.branaId : null };
  }

  async stavDoruceni(branaId: string): Promise<StavDoruceni> {
    return branaId.startsWith(PREFIX)
      ? this.skutecny.stavDoruceni(branaId.slice(PREFIX.length))
      : this.zaklad.stavDoruceni(branaId);
  }

  get zpracujWebhook() {
    return this.zaklad.zpracujWebhook?.bind(this.zaklad);
  }
}
