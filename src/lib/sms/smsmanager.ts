// SMS Manager — JSON API v2 (https://smsmanager.cz/docs/). Implementováno podle dokumentace (13. 10. 2026); naživo NEOVĚŘENO.
//
// Odeslání: POST https://api.smsmngr.com/v2/message, hlavička x-api-key,
//   {body, to:[{phone_number:"420777123456"}], sender?, tag:"transactional", flow:[{sms:{gateway:"high", type:"sms"}}]}
//   → 200 {request_id, accepted:[{key, message_id}], rejected:[{key}]}  (200 ≠ úspěch — kontrolovat rejected)
// Stav: GET https://rest-api.smsmngr.com/v1/message?id=<message_id> → message.status_code 200 = odesláno, delivery_code 201 = doručeno
// Webhook: POST pole událostí [{message_id, result: sending|sent|delivered|undelivered|rejected|failed, …}],
//   hlavička X-Request-Signature = HMAC-SHA256 hex surového těla (je-li nastaven default_callback_secret).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SmsChyba, type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';

export interface SmsManagerKonfigurace {
  apiKey: string;
  /** alfanumerický odesílatel (v ČR vyžaduje registraci u SMS Manageru) nebo virtuální číslo; prázdné = sdílený shortcode */
  odesilatel?: string;
  gateway?: 'high' | 'lowcost' | 'direct';
  /** tajemství pro ověření podpisu webhooku (default_callback_secret) */
  webhookSecret?: string;
  apiUrl?: string;
  restUrl?: string;
  fetch?: typeof fetch;
}

export const SMSMANAGER_STAVY: Record<string, StavDoruceni> = {
  sending: 'ceka',
  sent: 'odeslano',
  delivered: 'doruceno',
  seen: 'doruceno',
  undelivered: 'selhalo',
  rejected: 'selhalo',
  failed: 'selhalo',
};

export class SmsManager implements SmsPoskytovatel {
  readonly nazev = 'smsmanager';
  private f: typeof fetch;
  private apiUrl: string;
  private restUrl: string;

  constructor(private cfg: SmsManagerKonfigurace) {
    if (!cfg.apiKey) throw new Error('SMS Manager: chybí SMSMANAGER_APIKEY');
    this.f = cfg.fetch ?? fetch;
    this.apiUrl = (cfg.apiUrl ?? 'https://api.smsmngr.com/v2').replace(/\/$/, '');
    this.restUrl = (cfg.restUrl ?? 'https://rest-api.smsmngr.com/v1').replace(/\/$/, '');
  }

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    const telo: Record<string, unknown> = {
      body: text.slice(0, 1000),
      to: [{ phone_number: telefon.replace(/^\+/, '') }],
      tag: 'transactional',
      flow: [{ sms: { gateway: this.cfg.gateway ?? 'high', type: 'sms' } }],
    };
    if (this.cfg.odesilatel) telo.sender = this.cfg.odesilatel;
    const res = await this.f(`${this.apiUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey },
      body: JSON.stringify(telo),
    });
    if (!res.ok)
      throw new SmsChyba(
        `SMS Manager ${res.status}: ${(await res.text()).slice(0, 300)}`,
        res.status >= 500 || res.status === 503,
      );
    const data = (await res.json()) as {
      accepted?: { key: string; message_id: string }[];
      rejected?: { key: string }[];
    };
    const prijato = data.accepted?.[0];
    if (!prijato)
      throw new SmsChyba(`SMS Manager: zpráva odmítnuta (${JSON.stringify(data.rejected ?? [])})`);
    return { branaId: prijato.message_id };
  }

  async stavDoruceni(branaId: string): Promise<StavDoruceni> {
    const res = await this.f(`${this.restUrl}/message?id=${encodeURIComponent(branaId)}`, {
      headers: { 'x-api-key': this.cfg.apiKey },
    });
    if (!res.ok) return 'nezjisteno';
    const data = (await res.json()) as { message?: { status_code?: string; delivery_code?: string } | null };
    const m = data.message;
    if (!m) return 'nezjisteno';
    if (m.delivery_code === '201' || m.delivery_code === '202') return 'doruceno';
    if (m.status_code === '200') return 'odeslano';
    return 'nezjisteno';
  }

  // Webhook: tělo je pole událostí; podpis se ověřuje nad SUROVÝM tělem — volající musí předat `telo` jako string, když má tajemství.
  async zpracujWebhook(
    telo: unknown,
    hlavicky: Record<string, string | string[] | undefined>,
  ): Promise<{ branaId: string; stav: StavDoruceni }[]> {
    let data: unknown = telo;
    if (this.cfg.webhookSecret) {
      if (typeof telo !== 'string')
        throw new SmsChyba('SMS Manager webhook: pro ověření podpisu je třeba surové tělo');
      const podpis = String(hlavicky['x-request-signature'] ?? '');
      const ocekavany = createHmac('sha256', this.cfg.webhookSecret).update(telo).digest('hex');
      if (
        podpis.length !== ocekavany.length ||
        !timingSafeEqual(Buffer.from(podpis), Buffer.from(ocekavany))
      ) {
        throw new SmsChyba('SMS Manager webhook: neplatný podpis');
      }
      data = JSON.parse(telo);
    } else if (typeof telo === 'string') {
      data = JSON.parse(telo);
    }
    if (!Array.isArray(data)) return [];
    return (data as { message_id?: string; result?: string }[])
      .filter((u) => u.message_id && u.result)
      .map((u) => ({
        branaId: String(u.message_id),
        stav: SMSMANAGER_STAVY[String(u.result)] ?? 'nezjisteno',
      }));
  }
}
