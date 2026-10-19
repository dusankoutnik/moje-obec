// Provozní přehled pro dashboard správy: rozpočet SMS s kódy a stav fronty infokanálu. Jen agregáty — žádná čísla
// ani jména, aby se dalo ukázat komukoli ze správců.
import { sql } from 'kysely';
import type { Db } from '../db/index.js';

export interface PrehledSms {
  /** SMS s kódy za posledních 24 h (stejné okno, jakým se hlídá limit) */
  kodu24h: number;
  limit: number;
  /** záznam z nastavení, když se rozpočet naposledy vyčerpal (a je to méně než 24 h) */
  vycerpano: { at: string; pocet: number } | null;
  fronta: { ceka: number; odesilaSe: number; odeslano24h: number; vzdano24h: number } | null;
}

export async function prehledSms(db: Db, limit: number, sFrontou: boolean): Promise<PrehledSms> {
  const k = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM otp_kody
     WHERE kontakt LIKE '+%' AND vytvoren_at > now() - interval '24 hours'`.execute(db);
  const z = await db
    .selectFrom('nastaveni')
    .select('hodnota')
    .where('klic', '=', 'sms_rozpocet_vycerpan')
    .executeTakeFirst();
  let vycerpano: PrehledSms['vycerpano'] = null;
  if (z) {
    try {
      const v = (typeof z.hodnota === 'string' ? JSON.parse(z.hodnota) : z.hodnota) as {
        at?: string;
        pocet?: number;
      };
      if (v.at && Date.now() - Date.parse(v.at) < 24 * 3600_000)
        vycerpano = { at: v.at, pocet: Number(v.pocet ?? 0) };
    } catch {
      // poškozený záznam nastavení přehled neshodí
    }
  }
  let fronta: PrehledSms['fronta'] = null;
  if (sFrontou) {
    const f = await sql<{ ceka: number; odesila_se: number; odeslano: number; vzdano: number }>`
      SELECT
        count(*) FILTER (WHERE p.stav = 'ceka')::int AS ceka,
        count(*) FILTER (WHERE p.stav = 'odesila_se')::int AS odesila_se,
        count(*) FILTER (WHERE p.stav IN ('odeslano', 'doruceno') AND p.odeslano_at > now() - interval '24 hours')::int AS odeslano,
        count(*) FILTER (WHERE p.stav IN ('vzdano', 'selhalo')
                           AND coalesce(p.zabrano_at, h.vytvoreno_at) > now() - interval '24 hours')::int AS vzdano
        FROM ik_prijemci p JOIN ik_hlaseni h ON h.id = p.hlaseni_id
       WHERE p.stav IN ('ceka', 'odesila_se')
          OR coalesce(p.odeslano_at, p.zabrano_at, h.vytvoreno_at) > now() - interval '24 hours'`.execute(db);
    const r = f.rows[0]!;
    fronta = { ceka: r.ceka, odesilaSe: r.odesila_se, odeslano24h: r.odeslano, vzdano24h: r.vzdano };
  }
  return { kodu24h: k.rows[0]!.n, limit, vycerpano, fronta };
}
