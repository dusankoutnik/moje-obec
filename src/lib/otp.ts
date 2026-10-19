// Jednorázové kódy (SMS/e-mail): vydání s limitem 3/hod na kontakt, platnost 10 minut, max 5 pokusů na kód.
// Kódy jsou v DB jen jako HMAC — únik databáze nevydá platné kódy.
import type { Db } from '../db/index.js';
import type { OtpUcel } from '../db/types.js';
import { hmac, nahodnyKod } from './krypto.js';

export const OTP_PLATNOST_MIN = 10;
export const OTP_LIMIT_ZA_HODINU = 3;
export const OTP_MAX_POKUSU = 5;

export class OtpSluzba {
  constructor(
    private db: Db,
    private tajemstvi: string,
  ) {}

  private hash(kontakt: string, ucel: string, kod: string) {
    return hmac(this.tajemstvi, `${ucel}:${kontakt}:${kod}`);
  }

  // Vrátí kód k odeslání, nebo chybu `limit`, pokud kontakt v poslední hodině žádal příliš často.
  async vydej(kontakt: string, ucel: OtpUcel): Promise<{ kod: string } | { chyba: 'limit' }> {
    const predHodinou = new Date(Date.now() - 3600_000);
    const { pocet } = await this.db
      .selectFrom('otp_kody')
      .select((eb) => eb.fn.countAll<number>().as('pocet'))
      .where('kontakt', '=', kontakt)
      .where('vytvoren_at', '>', predHodinou)
      .executeTakeFirstOrThrow();
    if (Number(pocet) >= OTP_LIMIT_ZA_HODINU) return { chyba: 'limit' };
    const kod = nahodnyKod();
    await this.db
      .insertInto('otp_kody')
      .values({
        kontakt,
        ucel,
        kod_hash: this.hash(kontakt, ucel, kod),
        expires_at: new Date(Date.now() + OTP_PLATNOST_MIN * 60_000),
      })
      .execute();
    return { kod };
  }

  // Ověří kód; použitý kód zneplatní. Každý neúspěšný pokus se počítá; po 5 pokusech kód propadá.
  async over(kontakt: string, ucel: OtpUcel, kod: string): Promise<boolean> {
    const radek = await this.db
      .selectFrom('otp_kody')
      .selectAll()
      .where('kontakt', '=', kontakt)
      .where('ucel', '=', ucel)
      .where('pouzit_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where('pokusy', '<', OTP_MAX_POKUSU)
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!radek) return false;
    const ok = radek.kod_hash === this.hash(kontakt, ucel, String(kod).trim());
    if (ok) {
      await this.db
        .updateTable('otp_kody')
        .set({ pouzit_at: new Date() })
        .where('id', '=', radek.id)
        .execute();
    } else {
      await this.db
        .updateTable('otp_kody')
        .set((eb) => ({ pokusy: eb('pokusy', '+', 1) }))
        .where('id', '=', radek.id)
        .execute();
    }
    return ok;
  }

  // úklid starých kódů (cron)
  async uklid(): Promise<void> {
    await this.db
      .deleteFrom('otp_kody')
      .where('vytvoren_at', '<', new Date(Date.now() - 24 * 3600_000))
      .execute();
  }
}
