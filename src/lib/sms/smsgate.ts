// SMSGate (sms-gate.app) — Android telefon jako GSM brána, cloud nebo vlastní server.
// Používáme pro vývoj; pro obce není oficiální cestou (viz docs/MODULY.md — infokanál).
// API: POST <URL> {message, phoneNumbers:[…]} s Basic auth → 202 {id, state}; GET <URL>/<id> → {state}.
import { type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';
import { chybaOdpovedi, jsonZ, volejBranu } from './http.js';

export interface SmsGateKonfigurace {
  url: string; // např. https://api.sms-gate.app/3rdparty/v1/message
  user: string;
  pass: string;
  fetch?: typeof fetch;
  /** časový limit požadavku (ms) */
  timeoutMs?: number;
}

const STAVY: Record<string, StavDoruceni> = {
  Pending: 'ceka',
  Processed: 'ceka',
  Sent: 'odeslano',
  Delivered: 'doruceno',
  Failed: 'selhalo',
};

export class SmsGate implements SmsPoskytovatel {
  readonly nazev = 'smsgate';
  private auth: string;
  private f: typeof fetch;

  constructor(private cfg: SmsGateKonfigurace) {
    if (!cfg.url || !cfg.user) throw new Error('SMSGate: chybí SMSGATE_URL / SMSGATE_USER');
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64');
    this.f = cfg.fetch ?? fetch;
  }

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    const o = await volejBranu(
      this.f,
      'SMSGate',
      this.cfg.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.auth },
        body: JSON.stringify({ message: text, phoneNumbers: [telefon] }),
      },
      this.cfg.timeoutMs,
    );
    if (!o.ok) throw chybaOdpovedi('SMSGate', o);
    const data = jsonZ<{ id?: string }>(o) ?? {};
    return { branaId: data.id ?? null };
  }

  async stavDoruceni(branaId: string): Promise<StavDoruceni> {
    const o = await volejBranu(
      this.f,
      'SMSGate',
      `${this.cfg.url.replace(/\/$/, '')}/${encodeURIComponent(branaId)}`,
      { headers: { authorization: this.auth } },
      this.cfg.timeoutMs,
    ).catch(() => null);
    if (!o?.ok) return 'nezjisteno';
    const data = jsonZ<{ state?: string }>(o) ?? {};
    return STAVY[data.state ?? ''] ?? 'nezjisteno';
  }
}
