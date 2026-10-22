// Hlídání GSM brány SMSGate (telefon na úřadě) — převzato z VlastiKanálu (brana.js).
// Když se telefon dlouho neozve cloudu (typicky po restartu čeká na odemčení PINem), SMS se tiše hromadí
// ve stavu Pending. Proto à 10 min: lastSeen starší než BRANA_LIMIT_MIN → e-mail (BRANA_NOTIFY, jinak správci),
// připomínka à 12 h, po obnovení „zase funguje“. Nedostupný cloud SMSGate > 2 h → jedno upozornění.
// Stav v tabulce nastaveni (klíč infokanal_brana).
import type { Db } from '../../db/index.js';
import type { Logger } from '../../lib/logger.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import { emailySpravcu } from './prichozi.js';

export interface BranaKonfigurace {
  /** základ API SMSGate (…/3rdparty/v1) */
  zaklad: string;
  user: string;
  pass: string;
  limitMin: number;
  /** adresy (BRANA_NOTIFY); prázdné = správci obce */
  notify: string[];
  pripominkaH?: number;
  chybaH?: number;
  fetch?: typeof fetch;
}

interface StavBrany {
  alarm?: string | null; // ISO lastSeen při vyhlášení poplachu
  pripominka?: string | null;
  chybaOd?: string | null; // ISO začátku nedostupnosti cloudu, 'hlaseno' po upozornění
}

export type VysledekKontroly =
  | { stav: 'ok'; ticho: number }
  | { stav: 'offline'; ticho: number }
  | { stav: 'obnoveno' }
  | { stav: 'chyba' };

const KLIC = 'infokanal_brana';
const cas = (d: Date) =>
  d.toLocaleString('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export class HlidaniBrany {
  private f: typeof fetch;
  private auth: string;
  constructor(
    private db: Db,
    private mail: MailPoskytovatel,
    private cfg: BranaKonfigurace,
    private log: Logger,
  ) {
    this.f = cfg.fetch ?? fetch;
    this.auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  }

  private async nactiStav(): Promise<StavBrany> {
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC)
      .executeTakeFirst();
    return (r?.hodnota as StavBrany | undefined) ?? {};
  }

  private async ulozStav(s: StavBrany) {
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC, hodnota: JSON.stringify(s) })
      .onConflict((oc) =>
        oc.column('klic').doUpdateSet({ hodnota: JSON.stringify(s), upraven_at: new Date() }),
      )
      .execute();
  }

  private async api<T>(cesta: string): Promise<T> {
    const r = await this.f(this.cfg.zaklad.replace(/\/+$/, '') + cesta, {
      headers: { authorization: this.auth },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`SMSGate ${r.status}`);
    return (await r.json()) as T;
  }

  private async posledniKontakt(): Promise<Date> {
    const z = await this.api<unknown>('/devices');
    const casy = (Array.isArray(z) ? z : [])
      .map((d: { lastSeen?: string }) => Date.parse(d?.lastSeen ?? ''))
      .filter(Number.isFinite);
    if (!casy.length) throw new Error('SMSGate: žádné zařízení');
    return new Date(Math.max(...casy));
  }

  private async cekajicich(od: Date): Promise<number | null> {
    try {
      const z = await this.api<unknown>(`/messages?from=${encodeURIComponent(od.toISOString())}&limit=500`);
      const pole = Array.isArray(z) ? z : ((z as { items?: unknown[] })?.items ?? []);
      return (pole as { state?: string }[]).filter((m) => m?.state === 'Pending').length;
    } catch {
      return null;
    }
  }

  private async posli(predmet: string, text: string) {
    const komu = this.cfg.notify.length ? this.cfg.notify : await emailySpravcu(this.db);
    for (const adresa of komu) {
      try {
        await this.mail.posli({ komu: adresa, predmet: `[SMS brána] ${predmet}`, text });
      } catch (e) {
        this.log.warn({ err: e }, 'hlídání brány: e-mail se nepodařilo odeslat');
      }
    }
  }

  async kontrola(ted = new Date()): Promise<VysledekKontroly> {
    const s = await this.nactiStav();
    const chybaH = this.cfg.chybaH ?? 2;
    const pripominkaH = this.cfg.pripominkaH ?? 12;
    let lastSeen: Date;
    try {
      lastSeen = await this.posledniKontakt();
    } catch (e) {
      this.log.warn({ err: e }, 'hlídání brány: stav nelze zjistit');
      if (!s.chybaOd) {
        await this.ulozStav({ ...s, chybaOd: ted.toISOString() });
      } else if (s.chybaOd !== 'hlaseno' && ted.getTime() - Date.parse(s.chybaOd) > chybaH * 3600e3) {
        await this.ulozStav({ ...s, chybaOd: 'hlaseno' });
        await this.posli(
          'nelze ověřit stav brány',
          `Služba SMSGate (cloud) neodpovídá od ${cas(new Date(s.chybaOd))}, stav telefonu brány proto nejde ověřit.\n` +
            `Chyba: ${(e as Error).message}\n\nPokud SMS nechodí, zkontrolujte telefon na úřadě.`,
        );
      }
      return { stav: 'chyba' };
    }
    if (s.chybaOd) s.chybaOd = null;

    const ticho = (ted.getTime() - lastSeen.getTime()) / 60_000;
    if (ticho > this.cfg.limitMin) {
      if (!s.alarm || !s.pripominka || ted.getTime() - Date.parse(s.pripominka) > pripominkaH * 3600e3) {
        const n = await this.cekajicich(lastSeen);
        await this.posli(
          s.alarm ? 'stále offline' : 'telefon je offline — SMS neodcházejí',
          `Telefon SMS brány se naposledy ozval ${cas(lastSeen)}, tedy před ${Math.round((ticho / 60) * 10) / 10} h.\n` +
            (n != null ? `Ve frontě brány čeká ${n} SMS.\n` : '') +
            `\nNejspíš se restartoval (aktualizace) a čeká na odemčení PINem. Odemkněte prosím telefon na úřadě ` +
            `a ověřte, že běží aplikace SMSGate.\nČekající SMS se po připojení odešlou samy; přihlašovací kódy ` +
            `mezitím vypršely, lidé si musí říct o nový.\n\nDo té doby nechodí: kódy pro přihlášení, SMS ` +
            `infokanálu, rezervací a spolujízdy. E-maily fungují.`,
        );
        s.pripominka = ted.toISOString();
      }
      if (!s.alarm) s.alarm = lastSeen.toISOString();
      await this.ulozStav(s);
      return { stav: 'offline', ticho };
    }
    if (s.alarm) {
      const zacatek = new Date(s.alarm);
      await this.ulozStav({ alarm: null, pripominka: null, chybaOd: null });
      await this.posli(
        'zase funguje',
        `Telefon SMS brány je znovu připojený (ozval se ${cas(lastSeen)}). Výpadek začal ${cas(zacatek)}.\n` +
          `Čekající SMS se odesílají.`,
      );
      return { stav: 'obnoveno' };
    }
    await this.ulozStav(s);
    return { stav: 'ok', ticho };
  }
}
