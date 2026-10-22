// Tokeny integrací (API /api/v1): název, rozsahy oprávnění, poslední použití, zrušení. Token se ukáže jen jednou
// při založení; v databázi je jen jeho SHA-256. Ověření porovnává hash v konstantním čase.
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/index.js';
import type { ApiToken } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { stejneTajemstvi } from '../../lib/krypto.js';

export const ROZSAHY = [
  'obsah:cteni',
  'obsah:zapis',
  'deska:zapis',
  'infokanal:rozeslat',
  'zpravodaj',
] as const;
export type Rozsah = (typeof ROZSAHY)[number];

export const POPIS_ROZSAHU: Record<Rozsah, string> = {
  'obsah:cteni': 'čtení příspěvků a kategorií webu',
  'obsah:zapis': 'zakládání a úprava příspěvků (aktuality, akce, stránky) a nahrávání souborů',
  'deska:zapis': 'vyvěšování dokumentů na úřední desku',
  'infokanal:rozeslat': 'rozeslání příspěvku odběratelům infokanálu (e-mail, případně SMS)',
  zpravodaj: 'zveřejňování čísel obecního zpravodaje',
};

/** předpona tokenu — pozná se v logu nebo v úniku (skenery tajemství), nic neprozrazuje */
export const PREDPONA = 'wov_';

export function hashTokenu(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function jeRozsah(r: string): r is Rozsah {
  return (ROZSAHY as readonly string[]).includes(r);
}

export class ApiTokenySluzba {
  constructor(private db: Db) {}

  seznam() {
    return this.db
      .selectFrom('api_tokeny as t')
      .leftJoin('uzivatele as u', 'u.id', 't.zalozil_id')
      .selectAll('t')
      .select(['u.jmeno as zalozil_jmeno', 'u.prijmeni as zalozil_prijmeni'])
      .orderBy('t.zruseno_at', (ob) => ob.desc().nullsFirst())
      .orderBy('t.vytvoren_at', 'desc')
      .execute();
  }

  async zaloz(nazev: string, rozsahy: Rozsah[], aktorId: string, ip?: string | null) {
    const token = PREDPONA + randomBytes(32).toString('base64url');
    const r = await this.db
      .insertInto('api_tokeny')
      .values({
        nazev: nazev.slice(0, 120),
        hash: hashTokenu(token),
        prefix: token.slice(0, PREDPONA.length + 6),
        rozsahy: [...new Set(rozsahy)],
        zalozil_id: aktorId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'api.token_zalozen',
      detail: { id: r.id, nazev, rozsahy },
      ip,
    });
    return { id: r.id, token };
  }

  async zrus(id: string, aktorId: string, ip?: string | null): Promise<boolean> {
    const r = await this.db
      .updateTable('api_tokeny')
      .set({ zruseno_at: new Date(), zrusil_id: aktorId })
      .where('id', '=', id)
      .where('zruseno_at', 'is', null)
      .returning(['nazev'])
      .executeTakeFirst();
    if (!r) return false;
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'api.token_zrusen',
      detail: { id, nazev: r.nazev },
      ip,
    });
    return true;
  }

  /** platný (nezrušený) token podle hodnoty z hlavičky, jinak null */
  async over(token: string): Promise<ApiToken | null> {
    if (!token.startsWith(PREDPONA) || token.length > 200) return null;
    const hash = hashTokenu(token);
    const r = await this.db
      .selectFrom('api_tokeny')
      .selectAll()
      .where('hash', '=', hash)
      .where('zruseno_at', 'is', null)
      .executeTakeFirst();
    // hledá se podle hashe (index); porovnání ještě jednou v konstantním čase
    if (!r || !stejneTajemstvi(r.hash, hash)) return null;
    return r;
  }

  /** poslední použití (zapisuje se nejvýš jednou za minutu, počítadlo vždy) */
  async zapisPouziti(t: ApiToken, ip: string) {
    const ted = new Date();
    if (t.posledni_pouziti_at && ted.getTime() - t.posledni_pouziti_at.getTime() < 60_000) {
      await this.db
        .updateTable('api_tokeny')
        .set((eb) => ({ pouziti: eb('pouziti', '+', 1) }))
        .where('id', '=', t.id)
        .execute();
      return;
    }
    await this.db
      .updateTable('api_tokeny')
      .set((eb) => ({ pouziti: eb('pouziti', '+', 1), posledni_pouziti_at: ted, posledni_ip: ip }))
      .where('id', '=', t.id)
      .execute();
  }
}
