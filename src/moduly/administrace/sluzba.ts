// Úřední agenda nad účty platformy (náhrada MujÚčtu: posouzení rezidenta, účty bez jména, avíza správcům,
// statistiky). Jen agregáty a údaje pro správce — nic se nemaže.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Uzivatel } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { formatujTelefon } from '../../lib/kontakty.js';
import { celeJmeno, type UctySluzba } from '../ucty/sluzba.js';

export type PosliEmail = (prijemci: string[], predmet: string, text: string) => Promise<void>;

/** jak dlouho zpětně se nové účty se jménem hlásí správcům (starší převedené účty už posouzené jsou) */
const AVIZO_OKNO_DNI = 14;

export class AdministraceSluzba {
  constructor(
    private db: Db,
    private ucty: UctySluzba,
    private posli: PosliEmail,
    private cfg: { baseUrl: string; nazevObce: string },
  ) {}

  private jeJmeno() {
    return sql<boolean>`(jmeno <> '' OR prijmeni <> '')`;
  }

  /** účty se jménem, u kterých úřad ještě neposoudil, zda jde o rezidenta */
  kPosouzeni(limit = 100) {
    return this.db
      .selectFrom('uzivatele')
      .selectAll()
      .where(this.jeJmeno())
      .where('rezident_posouzen_at', 'is', null)
      .where('blokovan_at', 'is', null)
      .orderBy('vytvoren_at', 'desc')
      .limit(limit)
      .execute();
  }

  /** účty bez jména (vznikly přihlášením kódem neznámým telefonem nebo převodem) */
  bezJmena(limit = 100) {
    return this.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('jmeno', '=', '')
      .where('prijmeni', '=', '')
      .where('blokovan_at', 'is', null)
      .orderBy('vytvoren_at', 'desc')
      .limit(limit)
      .execute();
  }

  async pocty(): Promise<{ kPosouzeni: number; bezJmena: number }> {
    const r = await this.db
      .selectFrom('uzivatele')
      .select([
        sql<number>`count(*) FILTER (WHERE (jmeno <> '' OR prijmeni <> '') AND rezident_posouzen_at IS NULL)::int`.as(
          'k',
        ),
        sql<number>`count(*) FILTER (WHERE jmeno = '' AND prijmeni = '')::int`.as('b'),
      ])
      .where('blokovan_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { kPosouzeni: r.k, bezJmena: r.b };
  }

  private async emailySpravcu(): Promise<string[]> {
    const s = await this.ucty.podleRole(['admin', 'spravce']);
    return [...new Set(s.map((u) => u.email?.trim()).filter((e): e is string => !!e))];
  }

  private odkaz(u: Uzivatel) {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/sprava/uzivatele/${u.id}`;
  }

  /** posouzení úřadem: rezident ano/ne (zapíše rezident_posouzen_*, audit); po avízu oznámí vyřízení správcům */
  async posoudit(cil: Uzivatel, rezident: boolean, aktor: Uzivatel, ip?: string | null): Promise<Uzivatel> {
    const novy = await this.ucty.nastavRezident(cil, rezident, aktor, 'sprava-schvalovani', ip);
    const navic = (cil.navic ?? {}) as Record<string, unknown>;
    if (navic.rezident_avizo_at && !cil.rezident_posouzen_at) {
      const komu = await this.emailySpravcu();
      if (komu.length)
        await this.posli(
          komu,
          `✓ Vyřízeno: ${celeJmeno(cil)} — rezident ${rezident ? 'ANO' : 'NE'}`,
          `Účet ${celeJmeno(cil)} (${formatujTelefon(cil.telefon)}) posoudil(a) ${celeJmeno(aktor)}: ` +
            `rezident ${rezident ? 'ANO' : 'NE'}.\n\n${this.odkaz(cil)}\n`,
        ).catch(() => {});
    }
    return novy;
  }

  /** úřad doplní jméno účtu bez jména (přezdívka = křestní jméno, je-li prázdná) */
  async nastavJmeno(cil: Uzivatel, jmeno: string, prijmeni: string, aktor: Uzivatel, ip?: string | null) {
    const j = jmeno.trim().slice(0, 80);
    const p = prijmeni.trim().slice(0, 80);
    if (!j || !p) return { ok: false as const };
    await this.db
      .updateTable('uzivatele')
      .set({ jmeno: j, prijmeni: p, prezdivka: cil.prezdivka || j, upraven_at: new Date() })
      .where('id', '=', cil.id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: 'sprava.jmeno',
      detail: { cil: cil.id, cislo: cil.cislo, zdroj: 'sprava-schvalovani' },
      ip,
    });
    return { ok: true as const };
  }

  /**
   * Avízo správcům o novém účtu se jménem bez posouzení rezidenta (vzor MujÚčet rezident.js): každému účtu
   * jednou (navic.rezident_avizo_at), jen účty z posledních 14 dní. Vrací počet odeslaných avíz.
   */
  async avizoNovychUctu(): Promise<number> {
    const nove = await this.db
      .selectFrom('uzivatele')
      .selectAll()
      .where(this.jeJmeno())
      .where('rezident_posouzen_at', 'is', null)
      .where('blokovan_at', 'is', null)
      .where(sql<boolean>`NOT (navic ? 'rezident_avizo_at')`)
      .where('vytvoren_at', '>', new Date(Date.now() - AVIZO_OKNO_DNI * 86400_000))
      .orderBy('vytvoren_at')
      .limit(20)
      .execute();
    if (!nove.length) return 0;
    const komu = await this.emailySpravcu();
    let n = 0;
    for (const u of nove) {
      // značka napřed (atomicky jen jednou), e-mail až potom — dvě instance by jinak poslaly dvakrát
      const r = await this.db
        .updateTable('uzivatele')
        .set({
          navic: sql`navic || jsonb_build_object('rezident_avizo_at', ${new Date().toISOString()}::text)`,
        })
        .where('id', '=', u.id)
        .where(sql<boolean>`NOT (navic ? 'rezident_avizo_at')`)
        .executeTakeFirst();
      if (!Number(r.numUpdatedRows) || !komu.length) continue;
      await this.posli(
        komu,
        `⚠️ Nový účet: ${celeJmeno(u)} — posuďte, zda je rezident`,
        [
          `V ${this.cfg.nazevObce ? `obci ${this.cfg.nazevObce}` : 'obci'} vznikl nový účet, který čeká na posouzení rezidenta.`,
          '',
          `Jméno: ${celeJmeno(u)}`,
          `Telefon: ${formatujTelefon(u.telefon)}`,
          `E-mail: ${u.email || '—'}`,
          `Část obce: ${u.cast_obce || '—'}`,
          '',
          'Rezident ovlivňuje ceny rezervací (nerezidenti platí víc) a přístup do posilovny.',
          `Posoudit: ${this.cfg.baseUrl.replace(/\/$/, '')}/sprava/schvalovani`,
          `Detail účtu: ${this.odkaz(u)}`,
        ].join('\n'),
      ).catch(() => {});
      n++;
    }
    return n;
  }

  /** agregáty účtů a infokanálu pro Statistiky (bez jmen) */
  async statistiky() {
    const d30 = new Date(Date.now() - 30 * 86400_000);
    const ucty = await this.db
      .selectFrom('uzivatele')
      .select([
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL)::int`.as('celkem'),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NOT NULL)::int`.as('blokovanych'),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL AND rezident)::int`.as('rezidentu'),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL AND coalesce(email,'') <> '')::int`.as(
          'sEmailem',
        ),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL AND heslo_hash IS NOT NULL)::int`.as(
          'sHeslem',
        ),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL AND gdpr_souhlas_at IS NOT NULL)::int`.as(
          'gdpr',
        ),
        sql<number>`count(*) FILTER (WHERE blokovan_at IS NULL AND telefon_overen_at IS NOT NULL)::int`.as(
          'overenych',
        ),
        sql<number>`count(*) FILTER (WHERE vytvoren_at >= ${d30})::int`.as('novych30d'),
      ])
      .executeTakeFirstOrThrow();
    const prihlaseni = await this.db
      .selectFrom('audit_log')
      .select([
        sql<number>`count(*)::int`.as('prihlaseni30d'),
        sql<number>`count(DISTINCT uzivatel_id)::int`.as('aktivnich30d'),
      ])
      .where('akce', '=', 'prihlaseni')
      .where('ts', '>=', d30)
      .executeTakeFirstOrThrow();
    return { ucty: { ...ucty, ...prihlaseni } };
  }

  /** agregáty infokanálu (odběratelé, hlášení, odeslané SMS) — volat jen se zapnutým modulem infokanál */
  async statistikyInfokanalu() {
    const d30 = new Date(Date.now() - 30 * 86400_000);
    const mesic = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const o = await this.db
      .selectFrom('ik_odberatele')
      .select([
        sql<number>`count(*) FILTER (WHERE odhlasen_at IS NULL)::int`.as('odberatelu'),
        sql<number>`count(*) FILTER (WHERE odhlasen_at IS NULL AND overen_at IS NOT NULL)::int`.as(
          'overenych',
        ),
        sql<number>`count(*) FILTER (WHERE odhlasen_at IS NULL AND uzivatel_id IS NOT NULL)::int`.as(
          'sUctem',
        ),
        sql<number>`count(*) FILTER (WHERE odhlasen_at IS NULL AND kanal = 'sms')::int`.as('kanalSms'),
        sql<number>`count(*) FILTER (WHERE odhlasen_at IS NULL AND kanal = 'smisene')::int`.as(
          'kanalSmisene',
        ),
        sql<number>`count(*) FILTER (WHERE vytvoren_at >= ${d30})::int`.as('novych30d'),
        sql<number>`count(*) FILTER (WHERE odhlasen_at >= ${d30})::int`.as('odhlasenych30d'),
      ])
      .executeTakeFirstOrThrow();
    const h = await this.db
      .selectFrom('ik_hlaseni')
      .select([
        sql<number>`count(*)::int`.as('hlaseniCelkem'),
        sql<number>`count(*) FILTER (WHERE vytvoreno_at >= ${d30} AND stav <> 'zruseno')::int`.as(
          'hlaseni30d',
        ),
        sql<number>`count(*) FILTER (WHERE vytvoreno_at >= ${d30} AND krizove AND stav <> 'zruseno')::int`.as(
          'krizovych30d',
        ),
      ])
      .executeTakeFirstOrThrow();
    const smsH = await this.db
      .selectFrom('ik_prijemci')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('kanal', '=', 'sms')
      .where('stav', 'in', ['odeslano', 'doruceno'])
      .where('odeslano_at', '>=', mesic)
      .executeTakeFirstOrThrow();
    const smsO = await this.db
      .selectFrom('ik_odchozi')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('kanal', '=', 'sms')
      .where('stav', 'in', ['odeslano', 'doruceno'])
      .where('odeslano_at', '>=', mesic)
      .executeTakeFirstOrThrow();
    return { ...o, ...h, smsHlaseniMesic: smsH.n, smsOstatniMesic: smsO.n };
  }
}
