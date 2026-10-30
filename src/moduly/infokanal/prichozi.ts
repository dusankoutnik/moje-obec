// Příchozí SMS na číslo obce (jako ve VlastiKanálu):
//   START Jméno Příjmení = přihlášení k odběru (SMS z čísla = vlastnictví ověřeno, souhlas z registrační SMS);
//                  bez jména se odběr nezakládá — odpověď vysvětlí, co poslat (pokyn 2026-10-30),
//   STOP          = odhlášení,
//   ODVOZ <cíl>   = poptávka spolujízdy → předá se rezervacím po vnitřní síti ({phone, dest, text}),
//   cokoliv jiného = odpověď občana → přeposlat správcům e-mailem.
// Odpovědi se posílají odchozí frontou (opakování při výpadku brány).
import type { Db } from '../../db/index.js';
import { zapisAudit } from '../../lib/audit.js';
import { nahodnyToken } from '../../lib/krypto.js';
import { formatujTelefon, normalizujEmail } from '../../lib/kontakty.js';
import type { Logger } from '../../lib/logger.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import type { PrichoziSms } from '../../lib/sms/typy.js';
import type { OdchoziFronta } from './odchozi.js';
import { sql } from 'kysely';

export interface PrichoziKonfigurace {
  /** cílová adresa předání ODVOZ (null = spolujízda není napojená → přepošle se správcům) */
  odvozUrl: string | null;
  odvozHlavicky: Record<string, string>;
  /** adresy navíc ke správcům (INFOKANAL_NOTIFY) */
  notify: string[];
  nazevKanalu: string;
  fetch?: typeof fetch;
}

export type AkcePrichozi =
  'start' | 'start_bez_jmena' | 'restart' | 'stop' | 'odvoz' | 'odvoz_bez_cile' | 'preposlano';

export const ODPOVED_START_BEZ_JMENA =
  'Pro prihlaseni k odberu napiste START a sve jmeno a prijmeni, napr.: START Jan Novak';

/** e-maily správců (admin, spravce) s e-mailem a bez blokace + adresy navíc */
export async function emailySpravcu(db: Db, navic: string[] = []): Promise<string[]> {
  const r = await sql<{ email: string }>`
    SELECT email FROM uzivatele
     WHERE email IS NOT NULL AND blokovan_at IS NULL AND role && ARRAY['admin','spravce','provozovatel']::text[]`.execute(
    db,
  );
  const set = new Set<string>();
  for (const e of [...r.rows.map((x) => x.email), ...navic]) {
    const n = normalizujEmail(e);
    if (n) set.add(n);
  }
  return [...set];
}

export class PrichoziSluzba {
  private f: typeof fetch;
  constructor(
    private db: Db,
    private odchozi: OdchoziFronta,
    private mail: MailPoskytovatel,
    private cfg: PrichoziKonfigurace,
    private log: Logger,
  ) {
    this.f = cfg.fetch ?? fetch;
  }

  private odpovez(telefon: string, text: string) {
    return this.odchozi.zarad({ prijemci: [{ telefon }], sms: text, zdroj: 'infokanal-prichozi' });
  }

  async zpracuj(z: PrichoziSms): Promise<AkcePrichozi> {
    const text = z.text.trim();
    const od = z.od;
    const odvoz = /^odvoz\b(.*)$/is.exec(text);
    if (odvoz) {
      const cil = odvoz[1]!.trim().slice(0, 60);
      if (!cil) {
        await this.odpovez(od, 'Napiste prosim i cil, napr. ODVOZ Turnov.');
        return 'odvoz_bez_cile';
      }
      if (this.cfg.odvozUrl) {
        try {
          const r = await this.f(this.cfg.odvozUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...this.cfg.odvozHlavicky },
            body: JSON.stringify({ phone: od, dest: cil, text }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await zapisAudit(this.db, { akce: 'infokanal.sms_odvoz', detail: { cil } });
          return 'odvoz';
        } catch (e) {
          this.log.warn({ err: e }, 'příchozí SMS: předání ODVOZ rezervacím selhalo, přeposílám správcům');
        }
      }
      await this.preposli(od, text, 'Spolujízda není dostupná — SMS ODVOZ je potřeba vyřídit ručně.');
      return 'preposlano';
    }

    const existujici = await this.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('telefon', '=', od)
      .executeTakeFirst();
    const start = /^start\b(.*)$/is.exec(text);
    if (start) {
      const jmeno = start[1]!.trim().replace(/\s+/g, ' ').slice(0, 80);
      // jméno je povinné: jen „START“ nestačí (ani u známého odběratele, který jméno dosud nemá)
      if (!jmeno && !existujici?.jmeno) {
        await zapisAudit(this.db, { akce: 'infokanal.sms_start_bez_jmena', detail: { telefon: od } });
        await this.odpovez(od, ODPOVED_START_BEZ_JMENA);
        return 'start_bez_jmena';
      }
      let akce: AkcePrichozi;
      if (existujici) {
        await this.db
          .updateTable('ik_odberatele')
          .set({
            odhlasen_at: null,
            overen_at: existujici.overen_at ?? new Date(),
            ...(existujici.jmeno ? {} : { jmeno }),
          })
          .where('id', '=', existujici.id)
          .execute();
        await zapisAudit(this.db, { akce: 'infokanal.sms_restart', detail: { odberatel: existujici.id } });
        akce = 'restart';
      } else {
        const o = await this.db
          .insertInto('ik_odberatele')
          .values({
            jmeno,
            telefon: od,
            email: null,
            kanal: 'sms',
            token: nahodnyToken(16),
            zdroj: 'sms',
            souhlas_at: new Date(),
            overen_at: new Date(),
            poznamka: 'Souhlas z registrační SMS (START)',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await zapisAudit(this.db, { akce: 'infokanal.sms_start', detail: { odberatel: o.id } });
        akce = 'start';
      }
      await this.odpovez(od, 'Jste prihlaseni k odberu obecnich zprav. Odhlaseni: poslete STOP.');
      return akce;
    }
    if (/^stop\b/i.test(text)) {
      if (existujici && !existujici.odhlasen_at) {
        await this.db
          .updateTable('ik_odberatele')
          .set({ odhlasen_at: new Date() })
          .where('id', '=', existujici.id)
          .execute();
        await zapisAudit(this.db, {
          akce: 'infokanal.odhlaseni',
          detail: { odberatel: existujici.id, zpusob: 'sms' },
        });
      }
      await this.odpovez(od, 'Odber je zrusen. Znovu prihlasit: poslete START Jmeno Prijmeni.');
      return 'stop';
    }
    const kdo = existujici
      ? `${existujici.jmeno || 'odběratel'} (${formatujTelefon(od)}${existujici.cast_obce ? ', ' + existujici.cast_obce : ''})`
      : formatujTelefon(od);
    await this.preposli(od, text, '', kdo);
    return 'preposlano';
  }

  private async preposli(od: string, text: string, poznamka: string, kdo = formatujTelefon(od)) {
    const komu = await emailySpravcu(this.db, this.cfg.notify);
    if (!komu.length) this.log.warn('příchozí SMS: není komu přeposlat (žádný správce s e-mailem)');
    for (const adresa of komu) {
      await this.odchozi.zarad({
        prijemci: [{ email: adresa }],
        email: {
          predmet: `[${this.cfg.nazevKanalu}] Příchozí SMS od ${kdo}`,
          text:
            `Na číslo obce přišla SMS:\n\nOd: ${kdo}\nText: ${text}\n` +
            (poznamka ? `\n${poznamka}\n` : '') +
            `\n(Automaticky přeposláno, na SMS se z aplikace neodpovídá.)`,
        },
        zdroj: 'infokanal-prichozi',
      });
    }
  }
}
