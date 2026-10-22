// Odchozí fronta interního API (náhrada POST /api/send VlastiKanálu): jednotlivé SMS a e-maily aplikací obce
// (rezervace, spolujízda, avíza) i odpovědi na příchozí SMS. Stav drží DB (ik_odchozi), restart nic neztratí;
// dočasná chyba brány = další pokus s odkladem, po maxPokusu se zpráva vzdá. Zabírání řádku je atomické
// (FOR UPDATE SKIP LOCKED), takže dva procesy stejnou zprávu nepošlou dvakrát.
import { randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { Db } from '../../db/index.js';
import type { IkOdchoziTable } from '../../db/types.js';
import type { Logger } from '../../lib/logger.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import { SmsChyba, type SmsPoskytovatel } from '../../lib/sms/typy.js';
import { bezDiakritiky, normalizujEmail, normalizujTelefon } from '../../lib/kontakty.js';
import { MAX_SMS_ZNAKU } from './sluzba.js';

type Kanal = 'sms' | 'email';

export interface PozadavekOdeslani {
  prijemci: { telefon?: string | null; email?: string | null }[];
  sms?: string | null;
  email?: { predmet?: string; text?: string; html?: string | null } | null;
  zdroj?: string;
  /** SMS bez předpony obce (text ji už má, nebo jde o odpověď s vlastní hlavičkou) */
  bezPrefixu?: boolean;
}

export type VysledekZarazeni =
  | { id: string; sms: number; email: number; zkraceno: boolean }
  | { chyba: 'zadny_prijemce' | 'zadny_obsah' | 'prilis_prijemcu' };

export interface OdchoziKonfigurace {
  smsPrefix: string;
  smsIntervalMs?: number;
  emailIntervalMs?: number;
  maxPokusu?: number;
  maxPrijemcu?: number;
}

/** předpona obce před SMS (pokud ji text už nemá); bez diakritiky; zkráceno na MAX_SMS_ZNAKU */
export function smsSPrefixem(
  prefix: string,
  text: string,
  bezPrefixu = false,
): { text: string; zkraceno: boolean } {
  let t = bezDiakritiky(text.trim());
  const p = bezDiakritiky(prefix);
  if (!bezPrefixu && p && !t.toUpperCase().startsWith(p.trim().toUpperCase())) t = p + t;
  if (t.length <= MAX_SMS_ZNAKU) return { text: t, zkraceno: false };
  return { text: t.slice(0, MAX_SMS_ZNAKU - 3).trimEnd() + '...', zkraceno: true };
}

export class OdchoziFronta {
  private bezi: Record<Kanal, boolean> = { sms: false, email: false };
  private casovace: Record<Kanal, NodeJS.Timeout | null> = { sms: null, email: null };
  private zastaveno = false;
  readonly maxPokusu: number;

  constructor(
    private db: Db,
    private sms: SmsPoskytovatel,
    private mail: MailPoskytovatel,
    private cfg: OdchoziKonfigurace,
    private log: Logger,
  ) {
    this.maxPokusu = cfg.maxPokusu ?? 5;
  }

  vypniPlanovac() {
    this.zastaveno = true;
  }

  zastav() {
    this.zastaveno = true;
    for (const k of ['sms', 'email'] as Kanal[]) if (this.casovace[k]) clearTimeout(this.casovace[k]!);
  }

  kopni() {
    if (this.zastaveno) return;
    for (const k of ['sms', 'email'] as Kanal[]) if (!this.bezi[k]) this.naplanuj(k, 20);
  }

  private naplanuj(k: Kanal, ms: number) {
    if (this.zastaveno) return;
    if (this.casovace[k]) clearTimeout(this.casovace[k]!);
    this.casovace[k] = setTimeout(() => {
      this.krok(k).catch((e) => {
        this.log.error({ err: e, kanal: k }, 'odchozí fronta spadla, zkusím za 15 s');
        this.bezi[k] = false;
        this.naplanuj(k, 15_000);
      });
    }, ms);
  }

  /** zařadí zprávy do fronty; vrací id dávky (pro dotaz na stav) */
  async zarad(p: PozadavekOdeslani): Promise<VysledekZarazeni> {
    const smsText = typeof p.sms === 'string' && p.sms.trim() ? p.sms : null;
    const predmet = String(p.email?.predmet ?? '').trim();
    const text = String(p.email?.text ?? '').trim();
    const maEmail = !!(predmet && text);
    if (!smsText && !maEmail) return { chyba: 'zadny_obsah' };
    const prijemci = Array.isArray(p.prijemci) ? p.prijemci : [];
    if (prijemci.length > (this.cfg.maxPrijemcu ?? 50)) return { chyba: 'prilis_prijemcu' };
    const sms = smsText ? smsSPrefixem(this.cfg.smsPrefix, smsText, !!p.bezPrefixu) : null;
    const davka = randomUUID();
    const zdroj = String(p.zdroj ?? '').slice(0, 40);
    const radky: {
      davka: string;
      zdroj: string;
      kanal: Kanal;
      kontakt: string;
      sms_text: string | null;
      email_predmet: string | null;
      email_text: string | null;
      email_html: string | null;
    }[] = [];
    const videno = new Set<string>();
    for (const r of prijemci) {
      const tel = sms ? normalizujTelefon(r?.telefon) : null;
      const em = maEmail ? normalizujEmail(r?.email) : null;
      if (tel && !videno.has('s' + tel)) {
        videno.add('s' + tel);
        radky.push({
          davka,
          zdroj,
          kanal: 'sms',
          kontakt: tel,
          sms_text: sms!.text,
          email_predmet: null,
          email_text: null,
          email_html: null,
        });
      }
      if (em && !videno.has('e' + em)) {
        videno.add('e' + em);
        radky.push({
          davka,
          zdroj,
          kanal: 'email',
          kontakt: em,
          sms_text: null,
          email_predmet: predmet.slice(0, 200),
          email_text: text.slice(0, 50_000),
          email_html: p.email?.html ? String(p.email.html).slice(0, 200_000) : null,
        });
      }
    }
    if (!radky.length) return { chyba: 'zadny_prijemce' };
    await this.db.insertInto('ik_odchozi').values(radky).execute();
    if (sms?.zkraceno) this.log.warn({ zdroj, davka }, 'interní API: SMS zkrácena na limit');
    this.kopni();
    return {
      id: davka,
      sms: radky.filter((r) => r.kanal === 'sms').length,
      email: radky.filter((r) => r.kanal === 'email').length,
      zkraceno: !!sms?.zkraceno,
    };
  }

  async stavDavky(davka: string) {
    return this.db
      .selectFrom('ik_odchozi')
      .select(['kanal', 'stav', 'pokusy', 'posledni_chyba', 'odeslano_at', 'doruceno_at'])
      .where('davka', '=', davka)
      .orderBy('id')
      .execute();
  }

  private async zaber(k: Kanal) {
    const r = await sql<Selectable<IkOdchoziTable>>`
      WITH vybrany AS (
        SELECT id FROM ik_odchozi
         WHERE kanal = ${k} AND stav = 'ceka' AND (dalsi_pokus_at IS NULL OR dalsi_pokus_at <= now())
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE ik_odchozi o SET stav = 'odesila_se', zabrano_at = now(), pokusy = o.pokusy + 1
        FROM vybrany WHERE o.id = vybrany.id
      RETURNING o.*`.execute(this.db);
    return r.rows[0];
  }

  async krok(k: Kanal): Promise<boolean> {
    this.bezi[k] = true;
    const z = await this.zaber(k);
    if (!z) {
      this.bezi[k] = false;
      return false;
    }
    let branaId: string | null = null;
    try {
      if (k === 'sms') branaId = (await this.sms.posli(z.kontakt, z.sms_text ?? '')).branaId;
      else
        branaId = (
          await this.mail.posli({
            komu: z.kontakt,
            predmet: z.email_predmet ?? '',
            text: z.email_text ?? '',
            html: z.email_html ?? undefined,
          })
        ).id;
    } catch (e) {
      const docasna = e instanceof SmsChyba ? e.docasna : true;
      const vzdat = !docasna || z.pokusy >= this.maxPokusu;
      const zaMs = Math.min(
        Math.max(30_000 * 2 ** (z.pokusy - 1), e instanceof SmsChyba ? (e.zkusitZaMs ?? 0) : 0),
        3600_000,
      );
      this.log.warn({ err: e, odchozi: z.id, pokusy: z.pokusy, vzdat }, 'interní odeslání selhalo');
      await this.db
        .updateTable('ik_odchozi')
        .set({
          stav: vzdat ? 'vzdano' : 'ceka',
          posledni_chyba: (e as Error).message.slice(0, 300),
          dalsi_pokus_at: vzdat ? null : new Date(Date.now() + zaMs),
        })
        .where('id', '=', z.id)
        .execute();
      this.naplanuj(k, 500);
      return true;
    }
    await this.db
      .updateTable('ik_odchozi')
      .set({ stav: 'odeslano', brana_id: branaId, odeslano_at: new Date(), posledni_chyba: null })
      .where('id', '=', z.id)
      .execute()
      .catch((e) => this.log.error({ err: e, odchozi: z.id }, 'zpráva odešla, stav se nezapsal'));
    this.naplanuj(k, k === 'sms' ? (this.cfg.smsIntervalMs ?? 1000) : (this.cfg.emailIntervalMs ?? 200));
    return true;
  }

  /** zaseknuté (proces spadl při odesílání) — bereme jako odeslané, opakování by mohlo poslat zprávu dvakrát */
  async uklidZaseknute(starsiNezMs = 5 * 60_000) {
    const r = await this.db
      .updateTable('ik_odchozi')
      .set({
        stav: 'odeslano',
        odeslano_at: new Date(),
        posledni_chyba: 'odesílání přerušeno — neopakuje se',
      })
      .where('stav', '=', 'odesila_se')
      .where('zabrano_at', '<', new Date(Date.now() - starsiNezMs))
      .executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0);
  }

  async zpracujVse(): Promise<number> {
    let n = 0;
    const puvodni = this.zastaveno;
    this.zastaveno = true;
    for (const k of ['sms', 'email'] as Kanal[]) while (await this.krok(k)) n++;
    this.zastaveno = puvodni;
    return n;
  }

  /** doručenky z webhooku brány */
  async zapisDorucenky(zmeny: { branaId: string; stav: string }[]): Promise<number> {
    let n = 0;
    for (const z of zmeny) {
      if (z.stav !== 'doruceno' && z.stav !== 'selhalo') continue;
      const r = await this.db
        .updateTable('ik_odchozi')
        .set({ stav: z.stav, doruceno_at: z.stav === 'doruceno' ? new Date() : null })
        .where('brana_id', '=', z.branaId)
        .where('kanal', '=', 'sms')
        .where('stav', 'in', ['odeslano', 'odesila_se'])
        .executeTakeFirst();
      n += Number(r.numUpdatedRows);
    }
    return n;
  }

  /** doručenky dotazem na bránu (SMS posledních 48 h) */
  async aktualizujDorucenky(max = 300): Promise<number> {
    const radky = await this.db
      .selectFrom('ik_odchozi')
      .select(['id', 'brana_id'])
      .where('kanal', '=', 'sms')
      .where('stav', '=', 'odeslano')
      .where('brana_id', 'is not', null)
      .where('odeslano_at', '>', new Date(Date.now() - 48 * 3600_000))
      .orderBy('id')
      .limit(max)
      .execute();
    let n = 0;
    for (const r of radky) {
      const stav = await this.sms.stavDoruceni(r.brana_id!).catch(() => 'nezjisteno' as const);
      if (stav !== 'doruceno' && stav !== 'selhalo') continue;
      await this.db
        .updateTable('ik_odchozi')
        .set({ stav, doruceno_at: stav === 'doruceno' ? new Date() : null })
        .where('id', '=', r.id)
        .execute();
      n++;
    }
    return n;
  }
}
