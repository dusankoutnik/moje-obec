// SMSGate (sms-gate.app) — Android telefon jako GSM brána, cloud (api.sms-gate.app) nebo vlastní server.
// API (3rdparty/v1): POST <URL> {message, phoneNumbers:[…]} s Basic auth → 202 {id, state}; GET <URL>/<id> → {state}
// (Pending | Processed | Sent | Delivered | Failed). Webhooky (registrace POST <základ>/webhooks {url, event}):
// sms:received {payload:{message, phoneNumber, receivedAt}}, sms:sent | sms:delivered | sms:failed
// {payload:{messageId, phoneNumber, …}}. Podpis (je-li v aplikaci nastaven klíč): X-Signature =
// hex HMAC-SHA256(klíč, surové tělo + X-Timestamp), X-Timestamp = unixový čas v sekundách.
// POZOR: 202 znamená jen „přijato cloudem“ — když je telefon offline, zprávy visí v Pending (viz hlídání brány).
import { createHmac } from 'node:crypto';
import { normalizujTelefon } from '../kontakty.js';
import { stejneTajemstvi } from '../krypto.js';
import { type PrichoziSms, type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';
import { chybaOdpovedi, jsonZ, volejBranu } from './http.js';

export interface SmsGateKonfigurace {
  url: string; // např. https://api.sms-gate.app/3rdparty/v1/message
  user: string;
  pass: string;
  fetch?: typeof fetch;
  /** časový limit požadavku (ms) */
  timeoutMs?: number;
  /** podpisový klíč webhooků (nastavení aplikace SMSGate); prázdné = podpis se neověřuje */
  webhookKlic?: string;
}

const STAVY: Record<string, StavDoruceni> = {
  Pending: 'ceka',
  Processed: 'ceka',
  Sent: 'odeslano',
  Delivered: 'doruceno',
  Failed: 'selhalo',
};

const UDALOSTI: Record<string, StavDoruceni> = {
  'sms:sent': 'odeslano',
  'sms:delivered': 'doruceno',
  'sms:failed': 'selhalo',
};

interface WebhookTelo {
  event?: string;
  payload?: {
    messageId?: string;
    id?: string;
    message?: string;
    text?: string;
    phoneNumber?: string;
    sender?: string;
    phone?: string;
    receivedAt?: string;
  };
}

export class SmsGate implements SmsPoskytovatel {
  readonly nazev = 'smsgate';
  private auth: string;
  private f: typeof fetch;

  constructor(private cfg: SmsGateKonfigurace) {
    if (!cfg.url || !cfg.user) throw new Error('SMSGate: chybí SMSGATE_URL / SMSGATE_USER');
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64');
    this.f = cfg.fetch ?? fetch;
  }

  /** základ API bez koncového /message (…/3rdparty/v1) */
  get zakladApi(): string {
    return this.cfg.url.replace(/\/+$/, '').replace(/\/messages?$/, '');
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

  /** ověří podpis (je-li klíč) a přečte tělo webhooku */
  private telo(telo: unknown, hlavicky: Record<string, string | string[] | undefined>): WebhookTelo {
    const surove = typeof telo === 'string' ? telo : JSON.stringify(telo ?? {});
    if (this.cfg.webhookKlic) {
      const podpis = String(hlavicky['x-signature'] ?? '');
      const cas = String(hlavicky['x-timestamp'] ?? '');
      const ocekavany = createHmac('sha256', this.cfg.webhookKlic)
        .update(surove + cas)
        .digest('hex');
      if (!podpis || !stejneTajemstvi(podpis.toLowerCase(), ocekavany))
        throw new Error('SMSGate webhook: neplatný podpis');
      if (!/^\d+$/.test(cas) || Math.abs(Date.now() / 1000 - Number(cas)) > 600)
        throw new Error('SMSGate webhook: neplatný čas');
    }
    try {
      const d = JSON.parse(surove) as unknown;
      return d && typeof d === 'object' ? (d as WebhookTelo) : {};
    } catch {
      throw new Error('SMSGate webhook: tělo není JSON');
    }
  }

  async zpracujWebhook(telo: unknown, hlavicky: Record<string, string | string[] | undefined>) {
    const d = this.telo(telo, hlavicky);
    const stav = UDALOSTI[d.event ?? ''];
    const id = d.payload?.messageId ?? d.payload?.id;
    return stav && id ? [{ branaId: String(id), stav }] : [];
  }

  prichoziZWebhooku(telo: unknown, hlavicky: Record<string, string | string[] | undefined>): PrichoziSms[] {
    const d = this.telo(telo, hlavicky);
    if (d.event !== 'sms:received') return [];
    const p = d.payload ?? {};
    const od = normalizujTelefon(p.phoneNumber ?? p.sender ?? p.phone ?? '');
    const text = String(p.message ?? p.text ?? '').trim();
    if (!od || !text) return [];
    const prijato = p.receivedAt ? new Date(p.receivedAt) : null;
    return [
      {
        od,
        text: text.slice(0, 1600),
        prijato: prijato && !Number.isNaN(prijato.getTime()) ? prijato : null,
      },
    ];
  }
}
