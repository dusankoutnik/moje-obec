// Rozesílací worker: dva nezávislé proudy (SMS a e-mail), každý posílá po jedné zprávě s prodlevou.
// Tempo SMS je konfigurovatelné (IK_SMS_INTERVAL_*): u GSM brány na telefonu chrání SIM před anti-spam
// detekcí operátora, u komerční brány stačí malé. Krizová hlášení jedou nejrychleji.
// Stav drží DB (ik_prijemci.stav), takže restart nic neztratí. Řádek se před odesláním atomicky zabere
// (stav odesila_se), takže ani dva procesy najednou (překryv při nasazení) nepošlou stejnou zprávu dvakrát.
import { sql, type Selectable } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Hlaseni, IkPrijemciTable } from '../../db/types.js';
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

  /**
   * Atomicky zabere jednoho čekajícího příjemce (stav ceka → odesila_se). Dva workery (např. překryv při nasazení)
   * tak nikdy nedostanou stejný řádek: FOR UPDATE SKIP LOCKED přeskočí řádek, který právě bere jiný proces.
   */
  private async zaber(k: Kanal) {
    const r = await sql<Selectable<IkPrijemciTable> & { krizove: boolean }>`
      WITH vybrany AS (
        SELECT p.id FROM ik_prijemci p JOIN ik_hlaseni h ON h.id = p.hlaseni_id
         WHERE p.kanal = ${k} AND p.stav = 'ceka' AND h.stav = 'odesila_se'
           AND (p.dalsi_pokus_at IS NULL OR p.dalsi_pokus_at <= now())
         ORDER BY h.krizove DESC, p.id
         LIMIT 1
         FOR UPDATE OF p SKIP LOCKED
      )
      UPDATE ik_prijemci p SET stav = 'odesila_se', zabrano_at = now(), pokusy = p.pokusy + 1
        FROM vybrany, ik_hlaseni h
       WHERE p.id = vybrany.id AND p.stav = 'ceka' AND h.id = p.hlaseni_id
      RETURNING p.*, h.krizove`.execute(this.db);
    return r.rows[0];
  }

  /** zápis úspěšného odeslání (samostatně, aby šel v testech podvrhnout výpadek DB) */
  protected async zapisOdeslano(id: number, branaId: string | null) {
    await this.db
      .updateTable('ik_prijemci')
      .set({ stav: 'odeslano', brana_id: branaId, odeslano_at: new Date(), posledni_chyba: null })
      .where('id', '=', id)
      .where('stav', '=', 'odesila_se')
      .execute();
  }

  /**
   * Zprávy, které odešly, ale jejich stav se nepodařilo zapsat (výpadek DB) — zkusí se zapsat znovu.
   * Do fronty se nikdy nevracejí: druhé odeslání by občan dostal dvakrát a obec by ho zaplatila dvakrát.
   */
  private nezapsane = new Map<number, string | null>();

  private async dopisNezapsane() {
    for (const [id, branaId] of [...this.nezapsane]) {
      try {
        await this.zapisOdeslano(id, branaId);
        this.nezapsane.delete(id);
      } catch {
        return;
      }
    }
  }

  /**
   * Zaseknuté řádky (proces spadl mezi zabráním a zápisem výsledku): nevíme, zda zpráva odešla.
   * Bereme je jako odeslané — opakování by mohlo poslat zprávu podruhé.
   */
  async uklidZaseknute(starsiNezMs = 5 * 60_000) {
    const r = await this.db
      .updateTable('ik_prijemci')
      .set({
        stav: 'odeslano',
        odeslano_at: new Date(),
        posledni_chyba: 'odesílání bylo přerušeno — zpráva nejspíš odešla, neopakuje se',
      })
      .where('stav', '=', 'odesila_se')
      .where('zabrano_at', '<', new Date(Date.now() - starsiNezMs))
      .executeTakeFirst();
    const n = Number(r.numUpdatedRows ?? 0);
    if (n) this.log.warn({ n }, 'fronta: zaseknuté odesílání uzavřeno jako odeslané');
    return n;
  }

  /** jeden krok: pošle jednu zprávu daného kanálu; vrací true, když něco zpracoval */
  async krok(k: Kanal): Promise<boolean> {
    this.bezi[k] = true;
    if (this.nezapsane.size) await this.dopisNezapsane();
    await this.uzavriAPlanuj();
    const p = await this.zaber(k);
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
          .select(['token', 'jmeno', 'odhlasen_at'])
          .where('id', '=', p.odberatel_id)
          .executeTakeFirst()
      : null;
    // odhlásil se mezi naplánováním a odesláním → už nic neposílat (krizové zprávy dostane každý)
    if (odberatel?.odhlasen_at && !h.krizove) {
      await this.db
        .updateTable('ik_prijemci')
        .set({ stav: 'vzdano', posledni_chyba: 'odběratel se mezitím odhlásil' })
        .where('id', '=', p.id)
        .execute();
      this.naplanuj(k, 0);
      return true;
    }

    let branaId: string | null = null;
    try {
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
    } catch (e) {
      const chyba = e as Error;
      const docasna = e instanceof SmsChyba ? e.docasna : true;
      const vzdat = !docasna || p.pokusy >= this.maxPokusu;
      const zaMs = Math.min(Math.max(30_000, e instanceof SmsChyba ? (e.zkusitZaMs ?? 0) : 0), 3600_000);
      this.log.warn({ err: chyba, prijemce: p.id, pokusy: p.pokusy, vzdat }, 'odeslání selhalo');
      await this.db
        .updateTable('ik_prijemci')
        .set({
          stav: vzdat ? 'vzdano' : 'ceka',
          posledni_chyba: chyba.message.slice(0, 300),
          dalsi_pokus_at: vzdat ? null : new Date(Date.now() + zaMs),
        })
        .where('id', '=', p.id)
        .execute();
      // ostatní příjemci nečekají — tento řádek má odklad (dalsi_pokus_at)
      this.naplanuj(k, vzdat ? 0 : 1000);
      return true;
    }

    // Zpráva odešla. Chyba zápisu už nesmí vrátit řádek do fronty.
    try {
      await this.zapisOdeslano(p.id, branaId);
    } catch (e) {
      this.log.error(
        { err: e, prijemce: p.id },
        'zpráva odešla, ale stav se nepodařilo zapsat — zkusím později',
      );
      this.nezapsane.set(p.id, branaId);
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

  // doručenky: hromadně (brány s inboxem) a dotazem na jednotlivé nedávno odeslané SMS, po dávkách
  async aktualizujDorucenky(davka = 100, maxRadku = 2000): Promise<number> {
    let zmen = 0;
    if (this.sms.stahniDorucenky) {
      try {
        zmen += await this.zapisDorucenky(await this.sms.stahniDorucenky());
      } catch (e) {
        this.log.warn({ err: e }, 'hromadné stažení doručenek selhalo');
      }
    }
    let posledniId = 0;
    for (let zpracovano = 0; zpracovano < maxRadku;) {
      const radky = await this.db
        .selectFrom('ik_prijemci')
        .select(['id', 'brana_id'])
        .where('kanal', '=', 'sms')
        .where('stav', '=', 'odeslano')
        .where('brana_id', 'is not', null)
        .where('odeslano_at', '>', new Date(Date.now() - 48 * 3600_000))
        .where('id', '>', posledniId)
        .orderBy('id')
        .limit(davka)
        .execute();
      if (!radky.length) break;
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
      posledniId = radky.at(-1)!.id;
      zpracovano += radky.length;
      if (radky.length < davka) break;
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
        .where('stav', 'in', ['odeslano', 'odesila_se', 'doruceno', 'selhalo'])
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
