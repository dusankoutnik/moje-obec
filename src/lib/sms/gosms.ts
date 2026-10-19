// GoSMS.cz / GoSMS.eu — REST API (OpenAPI: https://doc.gosms.eu/gosms-api-definition_cs.json).
// Implementováno podle dokumentace (13. 10. 2026); naživo NEOVĚŘENO.
//
// Token: POST https://app.gosms.eu/oauth/v2/token (client_credentials) → {access_token, expires_in: 3600}
// Odeslání: POST https://app.gosms.eu/api/v1/messages {message, channel, recipients:[…]} → 201 {recipients:{invalid:[]}, link:"api/v1/messages/<id>"}
// Stav: GET /api/v1/messages/{id} → delivery.recipients.{delivered|undelivered|delivering}
// Webhook: POST pole událostí [{event:"delivery", delivery:{…}, links:{message:"/api/v1/messages/<id>"}}] — bez podpisu, jen Basic auth v URL.
import { SmsChyba, type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';

export interface GoSmsKonfigurace {
  clientId: string;
  clientSecret: string;
  /** ID kanálu (odesílatele) z GET /api/v1 */
  channel: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Delivery {
  isDelivered?: boolean;
  recipients?: {
    delivered?: Record<string, string>;
    undelivered?: Record<string, string>;
    delivering?: Record<string, unknown>;
  };
}

export function gosmsStav(d: Delivery | undefined, telefon?: string): StavDoruceni {
  if (!d?.recipients) return 'nezjisteno';
  const { delivered = {}, undelivered = {}, delivering = {} } = d.recipients;
  if (telefon) {
    if (telefon in delivered) return 'doruceno';
    if (telefon in undelivered) return 'selhalo';
    if (telefon in delivering) return 'odeslano';
    return 'nezjisteno';
  }
  if (Object.keys(delivered).length) return 'doruceno';
  if (Object.keys(undelivered).length) return 'selhalo';
  if (Object.keys(delivering).length) return 'odeslano';
  return 'nezjisteno';
}

export class GoSms implements SmsPoskytovatel {
  readonly nazev = 'gosms';
  private f: typeof fetch;
  private base: string;
  private token: { hodnota: string; platiDo: number } | null = null;

  constructor(private cfg: GoSmsKonfigurace) {
    if (!cfg.clientId || !cfg.clientSecret || !cfg.channel)
      throw new Error('GoSMS: chybí GOSMS_CLIENT_ID / GOSMS_CLIENT_SECRET / GOSMS_CHANNEL');
    this.f = cfg.fetch ?? fetch;
    this.base = (cfg.baseUrl ?? 'https://app.gosms.eu').replace(/\/$/, '');
  }

  private async ziskejToken(): Promise<string> {
    if (this.token && this.token.platiDo > Date.now() + 60_000) return this.token.hodnota;
    const res = await this.f(`${this.base}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok)
      throw new SmsChyba(`GoSMS token ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status >= 500);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { hodnota: data.access_token, platiDo: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async api(cesta: string, init: RequestInit = {}, opakovat = true): Promise<Response> {
    const token = await this.ziskejToken();
    const res = await this.f(`${this.base}${cesta}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && opakovat) {
      this.token = null;
      return this.api(cesta, init, false);
    }
    return res;
  }

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    const res = await this.api('/api/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, channel: Number(this.cfg.channel), recipients: [telefon] }),
    });
    if (res.status !== 201) {
      const t = await res.text();
      throw new SmsChyba(`GoSMS ${res.status}: ${t.slice(0, 300)}`, res.status >= 500);
    }
    const data = (await res.json()) as { link?: string; recipients?: { invalid?: string[] } };
    if (data.recipients?.invalid?.includes(telefon)) throw new SmsChyba(`GoSMS: neplatné číslo ${telefon}`);
    const id = data.link?.split('/').pop() ?? null;
    return { branaId: id };
  }

  async stavDoruceni(branaId: string): Promise<StavDoruceni> {
    const res = await this.api(`/api/v1/messages/${encodeURIComponent(branaId)}`);
    if (!res.ok) return 'nezjisteno';
    const data = (await res.json()) as { delivery?: Delivery };
    return gosmsStav(data.delivery);
  }

  async zpracujWebhook(telo: unknown): Promise<{ branaId: string; stav: StavDoruceni }[]> {
    // route webhooku předává JSON jako surový text (kvůli podpisu SMS Manageru)
    if (typeof telo === 'string') telo = JSON.parse(telo);
    if (!Array.isArray(telo)) return [];
    const vysledek: { branaId: string; stav: StavDoruceni }[] = [];
    for (const u of telo as { event?: string; delivery?: Delivery; links?: { message?: string } }[]) {
      if (u.event !== 'delivery') continue;
      const id = u.links?.message?.split('/').pop();
      if (id) vysledek.push({ branaId: id, stav: gosmsStav(u.delivery) });
    }
    return vysledek;
  }
}
