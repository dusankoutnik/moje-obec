// SMSbrána.cz — HTTP API „SMS Connect“ (https://www.smsbrana.cz/docs/SMSconnect_dokumentace.pdf).
// Implementováno podle dokumentace (13. 10. 2026); naživo zatím NEOVĚŘENO — první obec s SMSbránou ať pošle testovací SMS.
//
// Endpoint: GET https://api.smsbrana.cz/smsconnect/http.php?action=send_sms&number=…&message=…
// Auth (doporučená): login + time (YYYYMMDDTHHMMSS, Europe/Prague) + salt (náhodný, 1× denně) + auth = md5(password+time+salt).
// Dokumentace parametry jmenuje salt/auth, oficiální PHP klient posílá sul/hash — posíláme obojí.
// Odpověď: HTTP 200 + XML <result><err>0</err><price>1.1</price><sms_count>1</sms_count><credit>…</credit><sms_id>377351</sms_id></result>
// Doručenky: polling action=inbox (status 0 odesláno, 1 doručeno, 2 u operátora, 3 nedoručeno, 5 expirováno, 6 odmítnuto),
// nebo PUSH na URL nastavenou v administraci (GET/POST parametry income_id, number, status, time, sms_id).
import { createHash, randomBytes } from 'node:crypto';
import { SmsChyba, type SmsPoskytovatel, type StavDoruceni, type VysledekOdeslani } from './typy.js';
import { chybaOdpovedi, volejBranu } from './http.js';

export interface SmsBranaKonfigurace {
  login: string;
  password: string;
  /** ID autorizovaného čísla odesílatele (sender_id) — nepovinné */
  odesilatel?: string;
  url?: string;
  fetch?: typeof fetch;
  /** časový limit požadavku (ms) */
  timeoutMs?: number;
  /** pro testy: pevný čas */
  ted?: () => Date;
}

const CHYBY: Record<string, string> = {
  '-1': 'duplicitní user_id',
  '1': 'neznámá chyba',
  '2': 'neplatný login',
  '3': 'neplatný hash/heslo',
  '4': 'neplatný čas (time) — zkontrolujte hodiny serveru',
  '5': 'nepovolená IP adresa',
  '6': 'neplatná akce',
  '7': 'salt už byl dnes použit',
  '8': 'chyba databáze brány',
  '9': 'nedostatečný kredit',
  '10': 'neplatné telefonní číslo',
  '11': 'prázdný text zprávy',
  '12': 'zpráva delší než 459 znaků',
};
const DOCASNE = new Set(['1', '4', '7', '8']);

export const SMSBRANA_STAVY: Record<string, StavDoruceni> = {
  '0': 'odeslano',
  '1': 'doruceno',
  '2': 'odeslano',
  '3': 'selhalo',
  '5': 'selhalo',
  '6': 'selhalo',
};

// čas ve formátu YYYYMMDDTHHMMSS v pražském pásmu
export function smsbranaCas(d: Date): string {
  const p = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}${g('month')}${g('day')}T${g('hour')}${g('minute')}${g('second')}`;
}

export function xmlHodnota(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1]!.trim() : null;
}

export class SmsBrana implements SmsPoskytovatel {
  readonly nazev = 'smsbrana';
  private f: typeof fetch;
  private url: string;

  constructor(private cfg: SmsBranaKonfigurace) {
    if (!cfg.login || !cfg.password) throw new Error('SMSbrána: chybí SMSBRANA_LOGIN / SMSBRANA_PASSWORD');
    this.f = cfg.fetch ?? fetch;
    this.url = cfg.url ?? 'https://api.smsbrana.cz/smsconnect/http.php';
  }

  private auth(): Record<string, string> {
    const time = smsbranaCas((this.cfg.ted ?? (() => new Date()))());
    const salt = randomBytes(16).toString('hex');
    const auth = createHash('md5').update(`${this.cfg.password}${time}${salt}`).digest('hex');
    return { login: this.cfg.login, time, salt, sul: salt, auth, hash: auth };
  }

  private async zavolej(params: Record<string, string>): Promise<string> {
    const q = new URLSearchParams({ ...this.auth(), ...params });
    const o = await volejBranu(
      this.f,
      'SMSbrána',
      `${this.url}?${q.toString()}`,
      { method: 'GET' },
      this.cfg.timeoutMs,
    );
    if (!o.ok) throw chybaOdpovedi('SMSbrána', { ...o, text: '' });
    const err = xmlHodnota(o.text, 'err');
    // úspěch je jen výslovné <err>0</err> — HTML chybová stránka nebo prázdná odpověď není „odesláno“
    if (err === null) throw new SmsChyba('SMSbrána: neočekávaná odpověď (chybí <err>)', true);
    if (err !== '0')
      throw new SmsChyba(`SMSbrána chyba ${err}: ${CHYBY[err] ?? 'neznámá'}`, DOCASNE.has(err));
    return o.text;
  }

  async posli(telefon: string, text: string): Promise<VysledekOdeslani> {
    // delší text brána odmítne (chyba 12); tiché oříznutí by poslalo jiný text, než úřad schválil
    if (text.length > 459) throw new SmsChyba(`SMSbrána: zpráva má ${text.length} znaků, nejvýš 459`);
    const params: Record<string, string> = {
      action: 'send_sms',
      number: telefon,
      message: text,
      delivery_report: '1',
    };
    if (this.cfg.odesilatel) params.sender_id = this.cfg.odesilatel;
    const xml = await this.zavolej(params);
    const cena = xmlHodnota(xml, 'price');
    const segmentu = xmlHodnota(xml, 'sms_count');
    return {
      branaId: xmlHodnota(xml, 'sms_id'),
      cena: cena ? Number(cena) : undefined,
      segmentu: segmentu ? Number(segmentu) : undefined,
    };
  }

  // SMSbrána nemá dotaz na stav jedné zprávy — stavy chodí hromadně přes action=inbox (viz stahniDorucenky) nebo PUSH.
  async stavDoruceni(): Promise<StavDoruceni> {
    return 'nezjisteno';
  }

  // Polling doručenek: vrátí všechny stavy z inboxu (a smaže je u brány, aby nechodily znovu).
  async stahniDorucenky(): Promise<{ branaId: string; stav: StavDoruceni }[]> {
    const xml = await this.zavolej({ action: 'inbox', delete: '1' });
    return SmsBrana.parsujDorucenky(xml);
  }

  static parsujDorucenky(xml: string): { branaId: string; stav: StavDoruceni }[] {
    const vysledek: { branaId: string; stav: StavDoruceni }[] = [];
    const blok = /<delivery_report>([\s\S]*?)<\/delivery_report>/.exec(xml)?.[1] ?? '';
    for (const m of blok.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const id = xmlHodnota(m[1]!, 'idsms') ?? xmlHodnota(m[1]!, 'id_sms') ?? xmlHodnota(m[1]!, 'sms_id');
      const status = xmlHodnota(m[1]!, 'status');
      if (id && status) vysledek.push({ branaId: id, stav: SMSBRANA_STAVY[status] ?? 'nezjisteno' });
    }
    return vysledek;
  }

  // PUSH doručenka (GET/POST parametry): sms_id + status. Brána nepodepisuje — URL webhooku musí být tajná (s tokenem).
  async zpracujWebhook(telo: unknown): Promise<{ branaId: string; stav: StavDoruceni }[]> {
    const t = (telo ?? {}) as Record<string, string | undefined>;
    if (t.sms_id && t.status !== undefined)
      return [{ branaId: String(t.sms_id), stav: SMSBRANA_STAVY[String(t.status)] ?? 'nezjisteno' }];
    if (typeof telo === 'string' && telo.includes('<delivery_report>')) return SmsBrana.parsujDorucenky(telo);
    return [];
  }
}
