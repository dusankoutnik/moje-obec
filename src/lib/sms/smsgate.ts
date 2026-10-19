// SMSGate (sms-gate.app) — Android telefon jako GSM brána, cloud nebo vlastní server.
// Používáme pro vývoj; pro obce není oficiální cestou (viz docs/MODULY.md — infokanál).
// API: POST <URL> {message, phoneNumbers:[…]} s Basic auth → 202 {id, state}; GET <URL>/<id> → {state}.
import { SmsChyba, type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';

export interface SmsGateKonfigurace {
  url: string; // např. https://api.sms-gate.app/3rdparty/v1/message
  user: string;
  pass: string;
  fetch?: typeof fetch;
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
    const res = await this.f(this.cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.auth },
      body: JSON.stringify({ message: text.slice(0, 640), phoneNumbers: [telefon] }),
    });
    if (!res.ok)
      throw new SmsChyba(
        `SMSGate ${res.status}: ${(await res.text()).slice(0, 200)}`,
        res.status >= 500 || res.status === 429,
      );
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { branaId: data.id ?? null };
  }

  async stavDoruceni(branaId: string): Promise<StavDoruceni> {
    const res = await this.f(`${this.cfg.url.replace(/\/$/, '')}/${encodeURIComponent(branaId)}`, {
      headers: { authorization: this.auth },
    });
    if (!res.ok) return 'nezjisteno';
    const data = (await res.json().catch(() => ({}))) as { state?: string };
    return STAVY[data.state ?? ''] ?? 'nezjisteno';
  }
}
