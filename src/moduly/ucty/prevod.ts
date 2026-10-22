// Převod účtů z aplikace MůjÚčet (SQLite) do platformy. Logika oddělená od CLI (src/scripts/prevod-mujucet.ts),
// aby šla testovat. Idempotentní podle uzivatele.cislo (= id v MůjÚčtu); převedené účty mají navic.zdroj = 'mujucet'.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Role } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';

/** řádek tabulky users MůjÚčtu (jen sloupce, které převádíme) */
export interface MujUcetRadek {
  id: number;
  name: string;
  nickname: string;
  phone: string;
  email: string | null;
  password_hash: string | null;
  role: string;
  roles?: string | null;
  verified_at: string | null;
  blocked_at: string | null;
  color?: string | null;
  icon?: string | null;
  village?: string | null;
  created_at: string;
  gdpr_consent_at?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  is_resident?: number | null;
  eknihy_sms?: number | null;
  ekey_email_odmitnut?: string | null;
  rezident_posouzen_at?: string | null;
  rezident_posouzen_by?: number | null;
  rezident_avizo_at?: string | null;
}

export interface VolbyPrevodu {
  /** dev: jména, telefony a e-maily nahradit, hesla zahodit (čísla účtů a vazby zůstávají) */
  anonymizovat?: boolean;
  /** redaktor z MůjÚčtu (hlášení infokanálu) dostane i web + deska jako dnešní redaktoři platformy (výchozí ano) */
  redaktorWebDeska?: boolean;
  /** konflikt telefonem s účtem platformy, který z MůjÚčtu nepochází: připojit údaje k němu (jinak jen ohlásit) */
  sloucitTelefonem?: boolean;
}

export interface VysledekPrevodu {
  zdroj: number;
  vynechano_vymazane: number;
  vynechano_neplatne: number;
  zalozeno: number;
  aktualizovano: number;
  slouceno: number;
  precislovano: number;
  konflikty: { cislo: number; duvod: string }[];
  s_heslem: number;
  rezidenti: number;
  blokovano: number;
  s_rolemi: number;
  posledni_cislo: number;
}

// převáděné role (pořadí jako ROLE_ORDER MůjÚčtu); jiné hodnoty se zahodí
const ROLE_MUJUCET = ['admin', 'spravce', 'ucetni', 'redaktor', 'vstupne'] as const;

export function roleZMujUctu(r: Pick<MujUcetRadek, 'role' | 'roles'>, redaktorWebDeska = true): Role[] {
  const set = new Set(
    String(r.roles ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (r.role && r.role !== 'user') set.add(r.role);
  const vysledek = new Set<Role>(ROLE_MUJUCET.filter((x) => set.has(x)));
  // dnešní logika platformy: správce a redaktor smějí obsah webu i úřední desku
  if (vysledek.has('spravce') || (redaktorWebDeska && vysledek.has('redaktor'))) {
    vysledek.add('web');
    vysledek.add('deska');
  }
  return [...vysledek].sort();
}

/** MůjÚčet: „sůl:hash“ = scrypt (N=16384, r=8, p=1, 64 B, sůl jako hex text) → formát platformy (při přihlášení se přepočítá) */
export function prevedHash(h: string | null | undefined): string | null {
  if (!h) return null;
  const m = /^([0-9a-f]{16,128}):([0-9a-f]{128})$/.exec(h);
  return m ? `scrypt$16384$8$1$${m[1]}$${m[2]}` : null;
}
const PREVEDENY_HASH = 'scrypt$16384$8$1$';

/** čas MůjÚčtu „YYYY-MM-DD HH:MM:SS“ v místním čase (Europe/Prague, datetime('now','localtime')) → Date */
export function casZPrahy(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0)) as number[];
  const naivni = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!);
  // posun Prahy v tom okamžiku (dvakrát kvůli přechodu letního času)
  const posun = (t: number) => {
    const c = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Prague',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(t));
    const v = (k: string) => Number(c.find((p) => p.type === k)!.value);
    return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - t;
  };
  let t = naivni - posun(naivni);
  t = naivni - posun(t);
  return new Date(t);
}

export function jeVymazany(r: Pick<MujUcetRadek, 'name' | 'phone'>): boolean {
  return r.name === '[vymazáno]' || /^smazano-/.test(r.phone);
}

function jmenoPrijmeni(r: MujUcetRadek): { jmeno: string; prijmeni: string } {
  const j = (r.first_name ?? '').trim();
  const p = (r.last_name ?? '').trim();
  if (j || p) return { jmeno: j, prijmeni: p };
  // starší účty bez rozdělení: poslední slovo = příjmení (jako util.readName MůjÚčtu)
  const casti = String(r.name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return casti.length > 1
    ? { jmeno: casti.slice(0, -1).join(' '), prijmeni: casti[casti.length - 1]! }
    : { jmeno: '', prijmeni: casti[0] ?? '' };
}

export function anonymniTelefon(cislo: number): string {
  return `+42077${String(cislo).padStart(7, '0').slice(-7)}`;
}

export async function prevedUcty(
  db: Db,
  radky: MujUcetRadek[],
  volby: VolbyPrevodu = {},
): Promise<VysledekPrevodu> {
  const v: VysledekPrevodu = {
    zdroj: radky.length,
    vynechano_vymazane: 0,
    vynechano_neplatne: 0,
    zalozeno: 0,
    aktualizovano: 0,
    slouceno: 0,
    precislovano: 0,
    konflikty: [],
    s_heslem: 0,
    rezidenti: 0,
    blokovano: 0,
    s_rolemi: 0,
    posledni_cislo: 0,
  };
  const maxZdroj = radky.reduce((m, r) => Math.max(m, r.id), 0);

  // nanečisto: CLI předá rozběhnutou transakci, kterou pak zruší
  const vTransakci = <T>(f: (tx: Db) => Promise<T>) =>
    db.isTransaction ? f(db) : db.transaction().execute(f);
  await vTransakci(async (tx) => {
    // sekvenci posunout za nejvyšší id MůjÚčtu — nové účty platformy pak dostanou další volné číslo
    await sql`SELECT setval('uzivatele_cislo_seq', GREATEST((SELECT COALESCE(MAX(cislo), 0) FROM uzivatele), ${maxZdroj}, 1))`.execute(
      tx,
    );
    // účty platformy, které z MůjÚčtu nepocházejí (demo, ručně založené), ale mají číslo z rozsahu MůjÚčtu → přečíslovat
    const kolize = await tx
      .selectFrom('uzivatele')
      .select(['id', 'cislo'])
      .where('cislo', '<=', maxZdroj)
      .where(sql<boolean>`navic->>'zdroj' IS DISTINCT FROM 'mujucet'`)
      .execute();
    const zdrojCisla = new Set(radky.map((r) => r.id));
    for (const k of kolize) {
      if (!zdrojCisla.has(k.cislo)) continue;
      await tx
        .updateTable('uzivatele')
        .set({ cislo: sql<number>`nextval('uzivatele_cislo_seq')` })
        .where('id', '=', k.id)
        .execute();
      v.precislovano++;
    }

    for (const r of radky) {
      if (jeVymazany(r)) {
        v.vynechano_vymazane++;
        continue;
      }
      const telefonZdroj = String(r.phone ?? '').trim();
      if (
        !Number.isInteger(r.id) ||
        r.id < 1 ||
        (!volby.anonymizovat && !/^\+\d{9,15}$/.test(telefonZdroj))
      ) {
        v.vynechano_neplatne++;
        v.konflikty.push({ cislo: r.id, duvod: 'neplatné číslo účtu nebo telefon' });
        continue;
      }
      const { jmeno, prijmeni } = jmenoPrijmeni(r);
      const emailZdroj = (r.email ?? '').trim() || null;
      const anon = !!volby.anonymizovat;
      const telefon = anon ? anonymniTelefon(r.id) : telefonZdroj;
      const email = emailZdroj ? (anon ? `ucet${r.id}@dev.invalid` : emailZdroj) : null;
      const role = roleZMujUctu(r, volby.redaktorWebDeska !== false);
      const data = {
        telefon,
        email,
        jmeno: anon ? 'Občan' : jmeno,
        prijmeni: anon ? String(r.id) : prijmeni,
        prezdivka: anon ? `Občan ${r.id}` : String(r.nickname ?? '').trim(),
        cast_obce: String(r.village ?? '').trim(),
        role,
        rezident: !!r.is_resident,
        rezident_posouzen_at: casZPrahy(r.rezident_posouzen_at),
        rezident_posouzen_by: r.rezident_posouzen_by ?? null,
        gdpr_souhlas_at: casZPrahy(r.gdpr_consent_at),
        // MůjÚčet nastavoval verified_at po přihlášení kódem (na telefon i e-mail) — bereme jako ověřený telefon
        telefon_overen_at: casZPrahy(r.verified_at),
        blokovan_at: casZPrahy(r.blocked_at),
        vytvoren_at: casZPrahy(r.created_at) ?? new Date(),
        navic: JSON.stringify({
          zdroj: 'mujucet',
          barva: r.color ?? null,
          ikona: r.icon ?? '',
          eknihy_sms: !!r.eknihy_sms,
          ekey_email_odmitnut: anon
            ? r.ekey_email_odmitnut
              ? 'odmitnuto@dev.invalid'
              : null
            : (r.ekey_email_odmitnut ?? null),
          rezident_avizo_at: casZPrahy(r.rezident_avizo_at)?.toISOString() ?? null,
          hlavni_role: r.role ?? 'user',
          ...(anon ? { anonymizovano: true } : {}),
        }),
      };
      const hash = anon ? null : prevedHash(r.password_hash);

      const stavajici = await tx
        .selectFrom('uzivatele')
        .selectAll()
        .where('cislo', '=', r.id)
        .executeTakeFirst();
      // konflikty kontaktu s jiným účtem platformy
      const podleTel = await tx
        .selectFrom('uzivatele')
        .selectAll()
        .where('telefon', '=', telefon)
        .executeTakeFirst();
      const podleEmailu = email
        ? await tx
            .selectFrom('uzivatele')
            .selectAll()
            .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
            .executeTakeFirst()
        : undefined;

      let cil = stavajici;
      if (!cil && podleTel && podleTel.navic?.zdroj !== 'mujucet' && volby.sloucitTelefonem) {
        cil = podleTel;
        v.slouceno++;
      }
      if (podleTel && podleTel.id !== cil?.id) {
        v.konflikty.push({ cislo: r.id, duvod: `telefon už má účet platformy č. ${podleTel.cislo}` });
        continue;
      }
      const emailVolny = !podleEmailu || podleEmailu.id === cil?.id;
      if (!emailVolny)
        v.konflikty.push({
          cislo: r.id,
          duvod: `e-mail už má účet platformy č. ${podleEmailu!.cislo} — převeden bez e-mailu`,
        });
      const radek = { ...data, email: emailVolny ? data.email : null };

      if (cil) {
        // heslo: platforma ho po přihlášení přepočítala → nechat; jinak vzít z MůjÚčtu
        const ponechatHeslo = !!cil.heslo_hash && !cil.heslo_hash.startsWith(PREVEDENY_HASH);
        await tx
          .updateTable('uzivatele')
          .set({
            ...radek,
            cislo: r.id,
            heslo_hash: ponechatHeslo ? cil.heslo_hash : hash,
            // co už platforma zná, nepřepisovat prázdnou hodnotou
            gdpr_souhlas_at: radek.gdpr_souhlas_at ?? cil.gdpr_souhlas_at,
            telefon_overen_at: radek.telefon_overen_at ?? cil.telefon_overen_at,
            // demo/ruční účet sloučený telefonem si role ponechá a doplní o role z MůjÚčtu
            role: [
              ...new Set([...(cil.navic?.zdroj === 'mujucet' ? [] : cil.role), ...radek.role]),
            ].sort() as Role[],
            upraven_at: new Date(),
          })
          .where('id', '=', cil.id)
          .execute();
        if (stavajici) v.aktualizovano++;
      } else {
        await tx
          .insertInto('uzivatele')
          .values({ ...radek, cislo: r.id, heslo_hash: hash })
          .execute();
        v.zalozeno++;
      }
      if (hash) v.s_heslem++;
      if (radek.rezident) v.rezidenti++;
      if (radek.blokovan_at) v.blokovano++;
      if (radek.role.length) v.s_rolemi++;
    }
    const s = await sql<{ n: string }>`SELECT last_value AS n FROM uzivatele_cislo_seq`.execute(tx);
    v.posledni_cislo = Number(s.rows[0]?.n ?? 0);
    await zapisAudit(tx, {
      akce: 'prevod.mujucet',
      detail: { ...v, konflikty: v.konflikty.length, anonymizovano: !!volby.anonymizovat },
    });
  });
  return v;
}
