// Rozesílací worker: dva nezávislé proudy (SMS a e-mail), každý posílá po jedné zprávě s prodlevou.
// Tempo SMS je konfigurovatelné (IK_SMS_INTERVAL_*): u GSM brány na telefonu chrání SIM před anti-spam
// detekcí operátora, u komerční brány stačí malé. Krizová hlášení jedou nejrychleji.
// Worker je jediný na proces; stav drží DB (ik_prijemci.stav), takže restart nic neztratí.
import type { Db } from '../../db/index.js';
import type { Hlaseni } from '../../db/types.js';
import type { Logger } from '../../lib/logger.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import type { SmsPoskytovatel } from '../../lib/sms/typy.js';
import { SmsChyba } from '../../lib/sms/typy.js';
import { bezDiakritiky } from '../../lib/kontakty.js';

export interface FrontaKonfigurace {
  smsIntervalMinMs: number;
  smsIntervalMaxMs: number;
  emailIntervalMs: number;
  maxPokusu?: number;
  baseUrl: string;
  smsPrefix: string;
  nazevKanalu: string;
  nazevObce: string;
}

type Kanal = 'sms' | 'email';

export class RozesilaciFronta {
  private bezi: Record<Kanal, boolean> = { sms: false, email: false };
  private casovace: Record<Kanal, NodeJS.Timeout | null> = { sms: null, email: null };
  private zastaveno = false;
  readonly maxPokusu: number;

  /** worker bez plánovače (testy, jednorázové skripty): kopni() nic nedělá, zprávy posílá jen zpracujVse() */
  vypniPlanovac() {
    this.zastaveno = true;
  }

  constructor(
    private db: Db,
    private sms: SmsPoskytovatel,
    private mail: MailPoskytovatel,
    private cfg: FrontaKonfigurace,
    private log: Logger,
  ) {
    this.maxPokusu = cfg.maxPokusu ?? 3;
  }

  /** probudit worker (po založení hlášení, po startu) */
  kopni() {
    if (this.zastaveno) return;
    for (const k of ['sms', 'email'] as Kanal[]) if (!this.bezi[k]) this.naplanuj(k, 50);
  }

  zastav() {
    this.zastaveno = true;
    for (const k of ['sms', 'email'] as Kanal[]) if (this.casovace[k]) clearTimeout(this.casovace[k]!);
  }

  private naplanuj(k: Kanal, ms: number) {
    if (this.zastaveno) return;
    if (this.casovace[k]) clearTimeout(this.casovace[k]!);
    this.casovace[k] = setTimeout(() => {
      this.krok(k).catch((e) => {
        this.log.error({ err: e, kanal: k }, 'rozesílací worker spadl, zkusím za 15 s');
        this.bezi[k] = false;
        this.naplanuj(k, 15_000);
      });
    }, ms);
  }

  // naplánovaná hlášení, jejichž čas nastal → odesílají se; hlášení bez čekajících příjemců → hotovo
  async uzavriAPlanuj() {
    await this.db
      .updateTable('ik_hlaseni')
      .set({ stav: 'odesila_se' })
      .where('stav', '=', 'naplanovano')
      .where('naplanovano_na', '<=', new Date())
      .execute();
    await this.db
      .updateTable('ik_hlaseni')
      .set({ stav: 'hotovo', dokonceno_at: new Date() })
      .where('stav', '=', 'odesila_se')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('ik_prijemci')
              .select('id')
              .whereRef('ik_prijemci.hlaseni_id', '=', 'ik_hlaseni.id')
              .where('ik_prijemci.stav', '=', 'ceka'),
          ),
        ),
      )
      .execute();
  }

  /** jeden krok: pošle jednu zprávu daného kanálu; vrací true, když něco poslal */
  async krok(k: Kanal): Promise<boolean> {
    this.bezi[k] = true;
    await this.uzavriAPlanuj();
    const p = await this.db
      .selectFrom('ik_prijemci')
      .innerJoin('ik_hlaseni', 'ik_hlaseni.id', 'ik_prijemci.hlaseni_id')
      .selectAll('ik_prijemci')
      .select(['ik_hlaseni.krizove'])
      .where('ik_prijemci.kanal', '=', k)
      .where('ik_prijemci.stav', '=', 'ceka')
      .where('ik_hlaseni.stav', '=', 'odesila_se')
      .orderBy('ik_hlaseni.krizove', 'desc')
      .orderBy('ik_prijemci.id')
      .executeTakeFirst();
    if (!p) {
      this.bezi[k] = false;
      return false;
    }
    const h = await this.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .where('id', '=', p.hlaseni_id)
      .executeTakeFirstOrThrow();
    const odberatel = p.odberatel_id
      ? await this.db
          .selectFrom('ik_odberatele')
          .select(['token', 'jmeno'])
          .where('id', '=', p.odberatel_id)
          .executeTakeFirst()
      : null;
    try {
      let branaId: string | null = null;
      if (k === 'sms') branaId = (await this.sms.posli(p.kontakt, this.smsTelo(h))).branaId;
      else
        branaId = (
          await this.mail.posli({
            komu: p.kontakt,
            predmet: h.email_predmet ?? '',
            text: this.emailTelo(h, odberatel?.token),
            html: this.emailHtml(h, odberatel?.token),
          })
        ).id;
      await this.db
        .updateTable('ik_prijemci')
        .set((eb) => ({
          stav: 'odeslano',
          brana_id: branaId,
          odeslano_at: new Date(),
          pokusy: eb('pokusy', '+', 1),
          posledni_chyba: null,
        }))
        .where('id', '=', p.id)
        .execute();
    } catch (e) {
      const chyba = e as Error;
      const docasna = e instanceof SmsChyba ? e.docasna : true;
      const pokusy = p.pokusy + 1;
      const vzdat = !docasna || pokusy >= this.maxPokusu;
      this.log.warn({ err: chyba, prijemce: p.id, pokusy, vzdat }, 'odeslání selhalo');
      await this.db
        .updateTable('ik_prijemci')
        .set({ stav: vzdat ? 'vzdano' : 'ceka', pokusy, posledni_chyba: chyba.message.slice(0, 300) })
        .where('id', '=', p.id)
        .execute();
      if (!vzdat) {
        this.naplanuj(k, 30_000);
        return true;
      }
    }
    const prodleva =
      k === 'email'
        ? this.cfg.emailIntervalMs
        : p.krizove
          ? Math.min(this.cfg.smsIntervalMinMs, 500)
          : this.nahodne(this.cfg.smsIntervalMinMs, this.cfg.smsIntervalMaxMs);
    this.naplanuj(k, prodleva);
    return true;
  }

  // pro testy: zpracovat celou frontu bez prodlev
  async zpracujVse(): Promise<number> {
    let n = 0;
    const puvodni = this.zastaveno;
    this.zastaveno = true;
    for (const k of ['sms', 'email'] as Kanal[]) {
      while (await this.krok(k)) n++;
    }
    await this.uzavriAPlanuj();
    this.zastaveno = puvodni;
    return n;
  }

  // doručenky: polling stavů u poskytovatele pro nedávno odeslané SMS
  async aktualizujDorucenky(): Promise<number> {
    const radky = await this.db
      .selectFrom('ik_prijemci')
      .select(['id', 'brana_id'])
      .where('kanal', '=', 'sms')
      .where('stav', '=', 'odeslano')
      .where('brana_id', 'is not', null)
      .where('odeslano_at', '>', new Date(Date.now() - 48 * 3600_000))
      .limit(100)
      .execute();
    let zmen = 0;
    for (const r of radky) {
      const stav = await this.sms.stavDoruceni(r.brana_id!).catch(() => 'nezjisteno' as const);
      if (stav === 'doruceno' || stav === 'selhalo') {
        await this.db
          .updateTable('ik_prijemci')
          .set({ stav, doruceno_at: stav === 'doruceno' ? new Date() : null })
          .where('id', '=', r.id)
          .execute();
        zmen++;
      }
    }
    return zmen;
  }

  // doručenky z webhooku poskytovatele
  async zapisDorucenky(zmeny: { branaId: string; stav: string }[]): Promise<number> {
    let n = 0;
    for (const z of zmeny) {
      if (z.stav !== 'doruceno' && z.stav !== 'selhalo') continue;
      const r = await this.db
        .updateTable('ik_prijemci')
        .set({ stav: z.stav, doruceno_at: z.stav === 'doruceno' ? new Date() : null })
        .where('brana_id', '=', z.branaId)
        .where('kanal', '=', 'sms')
        .executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    return n;
  }

  smsTelo(h: Hlaseni): string {
    return bezDiakritiky(`${this.cfg.smsPrefix}${h.sms_text ?? ''}`);
  }

  emailTelo(h: Hlaseni, token?: string): string {
    const odhlasit = token
      ? `\n\nOdhlášení nebo úprava odběru: ${this.cfg.baseUrl}/infokanal/odhlasit/${token}`
      : '';
    return `${h.email_text ?? ''}\n\n—\n${this.cfg.nazevKanalu} — ${this.cfg.nazevObce}\n${this.cfg.baseUrl}/infokanal${odhlasit}`;
  }

  emailHtml(h: Hlaseni, token?: string): string {
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const telo =
      h.email_html ??
      esc(h.email_text ?? '')
        .split(/\n{2,}/)
        .map((o) => `<p>${o.replace(/\n/g, '<br>')}</p>`)
        .join('');
    const odhlasit = token
      ? `<br>Odhlášení nebo úprava odběru: <a href="${this.cfg.baseUrl}/infokanal/odhlasit/${token}">${this.cfg.baseUrl}/infokanal/odhlasit/${token}</a>`
      : '';
    return `<!doctype html><html lang="cs"><body style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#1a1a1a"><h1 style="font-size:20px">${esc(h.email_predmet ?? '')}</h1>${telo}<hr style="border:0;border-top:1px solid #ccc;margin:24px 0"><p style="font-size:13px;color:#555">${esc(this.cfg.nazevKanalu)} — ${esc(this.cfg.nazevObce)}<br><a href="${this.cfg.baseUrl}/infokanal">${this.cfg.baseUrl}/infokanal</a>${odhlasit}</p></body></html>`;
  }

  private nahodne(min: number, max: number) {
    return min + Math.floor(Math.random() * Math.max(0, max - min + 1));
  }
}
