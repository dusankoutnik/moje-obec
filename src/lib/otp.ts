// Jednorázové kódy (SMS/e-mail): platnost 10 minut, max 5 pokusů na kód, jen nejnovější kód kontaktu platí.
// Kódy jsou v DB jen jako HMAC — únik databáze nevydá platné kódy.
// Ochrana proti zneužití SMS (SMS pumping, zahlcení cizího čísla):
//   - limit 3 kódy za hodinu na kontakt a ÚČEL (útočník nevyčerpá oběti jiný účel, např. změnu údajů),
//   - prodleva mezi kódy na stejný kontakt (výchozí 60 s),
//   - telefon jen s povolenou předvolbou (výchozí +420, +421),
//   - denní rozpočet SMS s kódy pro celou instalaci; při vyčerpání se kódy SMSkou neposílají a správci dostanou upozornění.
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { OtpUcel } from '../db/types.js';
import { hmac, nahodnyKod } from './krypto.js';

export const OTP_PLATNOST_MIN = 10;
export const OTP_LIMIT_ZA_HODINU = 3;
export const OTP_MAX_POKUSU = 5;

export type OtpChyba = 'limit' | 'cooldown' | 'predvolba' | 'rozpocet';

export interface OtpVolby {
  /** minimální odstup dvou kódů na stejný kontakt (s); 0 = bez prodlevy */
  cooldownS?: number;
  /** povolené předvolby telefonů (E.164 začátek, např. '+420'); prázdné = jakékoli */
  predvolby?: string[];
  /** nejvýš kolik kódů SMSkou za 24 h pro celou instalaci; 0 = bez limitu */
  denniRozpocetSms?: number;
  /** zavolá se (nejvýš jednou za 24 h na proces), když se rozpočet vyčerpá */
  priVycerpaniRozpoctu?: (pocet: number) => void | Promise<void>;
}

export const VYCHOZI_PREDVOLBY = ['+420', '+421'];

/** '+420, +421' → ['+420', '+421'] (s plusem, bez mezer) */
export function rozeberPredvolby(s: string | undefined): string[] {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim().replace(/^00/, '+'))
    .filter((x) => /^\+\d{1,4}$/.test(x));
}

export class OtpSluzba {
  private upozornenoAt = 0;
  private readonly cooldownMs: number;
  private readonly predvolby: string[];

  constructor(
    private db: Db,
    private tajemstvi: string,
    private volby: OtpVolby = {},
  ) {
    this.cooldownMs = (volby.cooldownS ?? 60) * 1000;
    this.predvolby = volby.predvolby ?? VYCHOZI_PREDVOLBY;
  }

  private hash(kontakt: string, ucel: string, kod: string) {
    return hmac(this.tajemstvi, `${ucel}:${kontakt}:${kod}`);
  }

  /** smí se na toto číslo posílat SMS s kódem? (e-mail vždy) */
  povolenyKontakt(kontakt: string): boolean {
    if (!kontakt.startsWith('+') || !this.predvolby.length) return true;
    return this.predvolby.some((p) => kontakt.startsWith(p));
  }

  // Vrátí kód k odeslání, nebo důvod, proč kód teď vydat nejde.
  async vydej(kontakt: string, ucel: OtpUcel): Promise<{ kod: string } | { chyba: OtpChyba }> {
    if (!this.povolenyKontakt(kontakt)) return { chyba: 'predvolba' };
    const telefon = kontakt.startsWith('+');
    const kod = nahodnyKod();
    let vycerpano = 0;
    const v = await this.db.transaction().execute(async (trx) => {
      // souběžné žádosti o kód pro stejný kontakt se seřadí (jinak by obešly limit)
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'otp:' + kontakt}))`.execute(trx);
      const r = await sql<{ za_hodinu: number; posledni: Date | null }>`
        SELECT count(*) FILTER (WHERE ucel = ${ucel} AND vytvoren_at > now() - interval '1 hour')::int AS za_hodinu,
               max(vytvoren_at) AS posledni
          FROM otp_kody WHERE kontakt = ${kontakt} AND vytvoren_at > now() - interval '1 hour'`.execute(trx);
      const { za_hodinu, posledni } = r.rows[0]!;
      if (za_hodinu >= OTP_LIMIT_ZA_HODINU) return { chyba: 'limit' as const };
      if (this.cooldownMs > 0 && posledni && Date.now() - new Date(posledni).getTime() < this.cooldownMs)
        return { chyba: 'cooldown' as const };
      const rozpocet = this.volby.denniRozpocetSms ?? 0;
      if (telefon && rozpocet > 0) {
        const d = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM otp_kody
           WHERE kontakt LIKE '+%' AND vytvoren_at > now() - interval '24 hours'`.execute(trx);
        if (d.rows[0]!.n >= rozpocet) {
          vycerpano = d.rows[0]!.n;
          return { chyba: 'rozpocet' as const };
        }
      }
      await trx
        .insertInto('otp_kody')
        .values({
          kontakt,
          ucel,
          kod_hash: this.hash(kontakt, ucel, kod),
          expires_at: new Date(Date.now() + OTP_PLATNOST_MIN * 60_000),
        })
        .execute();
      return { kod };
    });
    if (vycerpano && Date.now() - this.upozornenoAt > 24 * 3600_000) {
      this.upozornenoAt = Date.now();
      try {
        await this.volby.priVycerpaniRozpoctu?.(vycerpano);
      } catch {
        // upozornění je doplněk — nesmí shodit žádost o kód
      }
    }
    return v;
  }

  /**
   * Ověří kód. Platí jen nejnovější nepoužitý kód kontaktu pro daný účel. Pokus se započítá atomicky
   * (UPDATE … WHERE pokusy < 5), takže ani souběžné požadavky nedostanou víc než 5 pokusů na kód,
   * a kód jde použít jen jednou.
   */
  async over(kontakt: string, ucel: OtpUcel, kod: string): Promise<boolean> {
    const r = await sql<{ id: number; kod_hash: string }>`
      UPDATE otp_kody SET pokusy = pokusy + 1
       WHERE id = (SELECT id FROM otp_kody
                    WHERE kontakt = ${kontakt} AND ucel = ${ucel} AND pouzit_at IS NULL AND expires_at > now()
                    ORDER BY id DESC LIMIT 1)
         AND pokusy < ${OTP_MAX_POKUSU} AND pouzit_at IS NULL
      RETURNING id, kod_hash`.execute(this.db);
    const radek = r.rows[0];
    if (!radek) return false;
    if (radek.kod_hash !== this.hash(kontakt, ucel, String(kod).trim())) return false;
    const pouzit = await this.db
      .updateTable('otp_kody')
      .set({ pouzit_at: new Date() })
      .where('id', '=', radek.id)
      .where('pouzit_at', 'is', null)
      .executeTakeFirst();
    return Number(pouzit.numUpdatedRows ?? 0) === 1;
  }

  // úklid starých kódů (cron)
  async uklid(): Promise<void> {
    await this.db
      .deleteFrom('otp_kody')
      .where('vytvoren_at', '<', new Date(Date.now() - 24 * 3600_000))
      .execute();
  }
}
