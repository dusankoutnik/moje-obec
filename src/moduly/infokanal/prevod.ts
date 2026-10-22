// Převod dat z VlastiKanálu (SQLite) do infokanálu platformy: odběratelé, kategorie, opt-outy, historie hlášení.
// Idempotentní: odběratel/hlášení se páruje podle prevod_id (id ve VlastiKanálu), u odběratele případně podle
// telefonu nebo e-mailu. Příjemci hlášení se nepřevádějí jednotlivě — jen souhrn počtů (ik_hlaseni.souhrn).
// Čtení SQLite (node:sqlite) je oddělené od zápisu (prevedVlastikanal), aby šel převod testovat bez souboru.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { KanalPreference, SouhrnHlaseni } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { casPraha } from '../../lib/datum.js';
import { nahodnyToken } from '../../lib/krypto.js';
import { normalizujEmail, normalizujTelefon } from '../../lib/kontakty.js';
import { prevedOdpoved, type ApiOdpoved } from '../odstavky/cez.js';

export interface VkOdberatel {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  village: string;
  token: string;
  verified_at: string | null;
  unsubscribed_at: string | null;
  source: string;
  consent_type: string | null;
  consent_at: string | null;
  note: string | null;
  created_at: string | null;
  user_id: number | null;
  channel_pref: string | null;
}
export interface VkKategorie {
  id: number;
  slug: string;
  name: string;
  optout: number;
  sort: number;
}
export interface VkHlaseni {
  id: number;
  author_user_id: number | null; // admins.user_id (číslo účtu MujÚčtu)
  category_id: number;
  is_crisis: number;
  target: string;
  target_detail: string | null;
  sms_text: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_html: string | null;
  web_title: string | null;
  web_body: string | null;
  web_html: string | null;
  wp_url: string | null;
  status: string;
  scheduled_at: string | null;
  created_at: string | null;
  finished_at: string | null;
  auto_source: string | null;
}
export interface VkData {
  odberatele: VkOdberatel[];
  kategorie: VkKategorie[];
  optouty: { subscriber_id: number; category_id: number }[];
  hlaseni: VkHlaseni[];
  prijemci: { message_id: number; channel: string; status: string; n: number }[];
  /** automatické výstrahy (tabulka vystrahy; starší VlastiKanál ji nemá) */
  vystrahy?: VkVystraha[];
  /** stav zdrojů výstrah z tabulky kv (chmu_last, chmu_ok, cez_ok, scvk_ok) */
  kv?: Record<string, string>;
}
export interface VkVystraha {
  id: number;
  source: string;
  ext_key: string;
  level: string | null;
  title: string;
  valid_from: string | null;
  valid_to: string | null;
  sms_text: string | null;
  email_subject: string | null;
  email_body: string | null;
  detail: string | null;
  status: string;
  message_id: number | null;
  reminded_at: string | null;
  cancelled_at: string | null;
  decided_user_id: number | null; // admins.user_id rozhodujícího správce
  decided_at: string | null;
  created_at: string | null;
}

/** slug VlastiKanálu → slug infokanálu platformy (ostatní se převezmou, případně založí) */
export const MAPA_KATEGORII: Record<string, string> = {
  krizove: 'krizove',
  dulezite: 'hlaseni',
  cviceni: 'sport',
  kultura: 'kultura',
  sluzby: 'sluzby',
  pocasi: 'pocasi',
  elektrina: 'elektrina',
  voda: 'voda',
};

const KANALY: Record<string, KanalPreference> = { sms: 'sms', mixed: 'smisene', email: 'email' };
const ZDROJE: Record<string, string> = { infokanal: 'import', mujucet: 'ucet' };
const STAVY_PRIJEMCU: Record<string, string> = {
  queued: 'ceka',
  sent: 'odeslano',
  delivered: 'doruceno',
  failed: 'selhalo',
  gaveup: 'vzdano',
  skipped: 'vzdano',
};
const AUTOMATY: Record<string, string> = { ČEZ: 'cez', SčVK: 'voda', ČHMÚ: 'chmu', chmu: 'chmu', cez: 'cez' };

/** čas z VlastiKanálu: 'YYYY-MM-DD HH:MM:SS' (místní čas), 'DD.MM.YYYY HH:MM[:SS]' nebo ISO s časovou zónou */
export function casVk(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = String(s).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) && t.includes('T')) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m) return casPraha(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m)
    return casPraha(
      `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`,
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    );
  return null;
}

export interface VolbyPrevodu {
  nanecisto?: boolean;
  anonymizovat?: boolean;
  /** kód obce (ČSÚ/RÚIAN) pro převod detailu odstávek ČEZ na části obce */
  kodObce?: string;
}

const STAVY_VYSTRAH: Record<string, 'odeslano' | 'ceka' | 'zahozeno' | 'preskoceno'> = {
  sent: 'odeslano',
  pending: 'ceka',
  deleted: 'zahozeno',
  skipped: 'preskoceno',
};

/** detail výstrahy VlastiKanálu → tvar, se kterým pracuje modul výstrah platformy (data jako ISO řetězce) */
export function detailVystrahy(v: VkVystraha, kodObce = ''): Record<string, unknown> {
  let d: Record<string, unknown> = {};
  try {
    const x = JSON.parse(v.detail ?? '{}') as unknown;
    if (x && typeof x === 'object') d = x as Record<string, unknown>;
  } catch {
    /* neplatný JSON */
  }
  const iso = (x: unknown) => casVk(typeof x === 'string' ? x : null)?.toISOString() ?? null;
  if (v.source === 'cez') {
    const o = kodObce
      ? prevedOdpoved({ outages_in_town: [d] } as unknown as ApiOdpoved, kodObce)[0]
      : undefined;
    return {
      ...(o ?? { id: String(d.id ?? v.ext_key), pdf: null, casti: [], parcely: [] }),
      id: String(d.id ?? v.ext_key),
      od: iso(d.opened_at) ?? iso(v.valid_from),
      do: iso(d.fix_expected_at) ?? iso(v.valid_to),
      zruseno: iso(d.cancelled_at) ?? (v.cancelled_at ? iso(v.cancelled_at) : null),
    };
  }
  if (v.source === 'scvk')
    return {
      id: String(d.id ?? v.ext_key),
      href: d.href ?? '',
      typ: d.typ === 'havarie' ? 'havarie' : 'planovana',
      titulek: d.title ?? v.title,
      zverejneno: d.published ?? '',
      od: iso(d.from) ?? iso(v.valid_from),
      do: iso(d.to) ?? iso(v.valid_to),
      text: d.text ?? '',
      soubor: d.file ?? null,
    };
  if (v.source === 'chmu')
    return {
      jev: d.event ?? v.ext_key.split('|')[0],
      stupen: d.level ?? v.level,
      od: iso(d.from) ?? iso(v.valid_from),
      do: iso(d.to) ?? iso(v.valid_to),
      nadpis: d.headline ?? '',
      popis: d.description ?? '',
      pokyny: d.instruction ?? '',
    };
  return d;
}

export interface VysledekPrevodu {
  odberatelu: number;
  odberateluNovych: number;
  odberateluAktualizovanych: number;
  odberateluBezKontaktu: number;
  emailuObsazenych: number;
  vazebNaUcet: number;
  vazebSparovanych: number;
  kategoriiZalozenych: number;
  optoutu: number;
  hlaseni: number;
  hlaseniNovych: number;
  hlaseniNedokoncenych: number;
  vystrah: number;
  vystrahNovych: number;
  vystrahUzZnamych: number;
  vystrahSHlasenim: number;
  vystrahPodleStavu: Record<string, number>;
}

/** anonymní kontakty pro dev (deterministické podle id, vazby zůstávají) */
export function anonymniOdberatel(o: VkOdberatel): VkOdberatel {
  return {
    ...o,
    name: `Odběratel ${o.id}`,
    phone: o.phone ? `+420799${String(o.id).padStart(6, '0')}` : null,
    email: o.email ? `odberatel${o.id}@demo.invalid` : null,
    note: null,
    token: '',
  };
}

async function maSloupecCislo(db: Db): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'uzivatele' AND column_name = 'cislo'`.execute(
    db,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** číslo účtu MujÚčtu → id uživatele platformy (prázdná mapa, dokud sloupec uzivatele.cislo neexistuje) */
async function mapaUctu(db: Db): Promise<Map<number, string>> {
  if (!(await maSloupecCislo(db))) return new Map();
  const r = await sql<{ id: string; cislo: number }>`
    SELECT id, cislo FROM uzivatele WHERE cislo IS NOT NULL`.execute(db);
  return new Map(r.rows.map((x) => [Number(x.cislo), x.id]));
}

/**
 * Dopáruje vazbu odběratel → účet podle mujucet_cislo (po převodu účtů). Vrací počet nově spárovaných.
 * Bezpečné opakovat; existující vazbu nepřepisuje.
 */
export async function doparujUcty(db: Db): Promise<number> {
  if (!(await maSloupecCislo(db))) return 0;
  const r = await sql`
    UPDATE ik_odberatele o SET uzivatel_id = u.id
      FROM uzivatele u
     WHERE o.mujucet_cislo IS NOT NULL AND o.uzivatel_id IS NULL AND u.cislo = o.mujucet_cislo`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export async function prevedVlastikanal(
  db: Db,
  data: VkData,
  volby: VolbyPrevodu = {},
): Promise<VysledekPrevodu> {
  const v: VysledekPrevodu = {
    odberatelu: 0,
    odberateluNovych: 0,
    odberateluAktualizovanych: 0,
    odberateluBezKontaktu: 0,
    emailuObsazenych: 0,
    vazebNaUcet: 0,
    vazebSparovanych: 0,
    kategoriiZalozenych: 0,
    optoutu: 0,
    hlaseni: 0,
    hlaseniNovych: 0,
    hlaseniNedokoncenych: 0,
    vystrah: 0,
    vystrahNovych: 0,
    vystrahUzZnamych: 0,
    vystrahSHlasenim: 0,
    vystrahPodleStavu: {},
  };
  const ucty = await mapaUctu(db);

  const prace = async (trx: Db) => {
    // ---- kategorie ----
    const existujici = new Map(
      (await trx.selectFrom('ik_kategorie').select(['id', 'slug']).execute()).map((k) => [k.slug, k.id]),
    );
    const katVk = new Map<number, number>(); // id VK → id platformy
    for (const k of data.kategorie) {
      const slug = MAPA_KATEGORII[k.slug] ?? k.slug;
      let id = existujici.get(slug);
      if (id === undefined) {
        id = (
          await trx
            .insertInto('ik_kategorie')
            .values({ slug, nazev: k.name, povinna: !k.optout, poradi: k.sort })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        existujici.set(slug, id);
        v.kategoriiZalozenych++;
      }
      katVk.set(k.id, id);
    }
    const hlaseniKat = existujici.get('hlaseni')!;

    // ---- odběratelé ----
    const odbVk = new Map<number, string>(); // id VK → id platformy
    for (const puvodni of data.odberatele) {
      const o = volby.anonymizovat ? anonymniOdberatel(puvodni) : puvodni;
      const telefon = normalizujTelefon(o.phone);
      let email = normalizujEmail(o.email);
      if (!telefon && !email) v.odberateluBezKontaktu++;
      const najdi = async () => {
        const podle = await trx
          .selectFrom('ik_odberatele')
          .select(['id', 'token'])
          .where('prevod_id', '=', o.id)
          .executeTakeFirst();
        if (podle) return podle;
        if (telefon) {
          const t = await trx
            .selectFrom('ik_odberatele')
            .select(['id', 'token'])
            .where('telefon', '=', telefon)
            .where('prevod_id', 'is', null)
            .executeTakeFirst();
          if (t) return t;
        }
        if (email)
          return trx
            .selectFrom('ik_odberatele')
            .select(['id', 'token'])
            .where(sql<boolean>`lower(email) = ${email}`)
            .where('prevod_id', 'is', null)
            .executeTakeFirst();
        return undefined;
      };
      const ex = await najdi();
      if (email) {
        const jiny = await trx
          .selectFrom('ik_odberatele')
          .select('id')
          .where(sql<boolean>`lower(email) = ${email}`)
          .$if(!!ex, (q) => q.where('id', '!=', ex!.id))
          .executeTakeFirst();
        if (jiny) {
          email = null;
          v.emailuObsazenych++;
        }
      }
      const souhlas = [o.consent_type, o.note].filter(Boolean).join(' — ');
      const uzivatelId = o.user_id ? (ucty.get(Number(o.user_id)) ?? null) : null;
      if (o.user_id) v.vazebNaUcet++;
      if (uzivatelId) v.vazebSparovanych++;
      const hodnoty = {
        jmeno: (o.name ?? '').trim().slice(0, 120),
        telefon,
        email,
        cast_obce: (o.village ?? '').trim(),
        kanal: KANALY[o.channel_pref ?? ''] ?? (telefon ? 'sms' : 'email'),
        overen_at: casVk(o.verified_at),
        odhlasen_at: casVk(o.unsubscribed_at),
        zdroj: ZDROJE[o.source] ?? o.source ?? 'import',
        souhlas_at: casVk(o.consent_at) ?? (o.consent_type ? casVk(o.created_at) : null),
        poznamka: souhlas
          ? `Převedeno z VlastiKanálu. Souhlas: ${souhlas}`.slice(0, 1000)
          : 'Převedeno z VlastiKanálu.',
        prevod_id: o.id,
        mujucet_cislo: o.user_id ? Number(o.user_id) : null,
        ...(uzivatelId ? { uzivatel_id: uzivatelId } : {}),
      };
      let id: string;
      if (ex) {
        await trx.updateTable('ik_odberatele').set(hodnoty).where('id', '=', ex.id).execute();
        id = ex.id;
        v.odberateluAktualizovanych++;
      } else {
        // původní token zachovat (odhlašovací odkazy ve starých e-mailech), pokud není obsazený
        let token = o.token || nahodnyToken(16);
        const obsazeny = await trx
          .selectFrom('ik_odberatele')
          .select('id')
          .where('token', '=', token)
          .executeTakeFirst();
        if (obsazeny) token = nahodnyToken(16);
        id = (
          await trx
            .insertInto('ik_odberatele')
            .values({ ...hodnoty, token, vytvoren_at: casVk(o.created_at) ?? new Date() })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        v.odberateluNovych++;
      }
      odbVk.set(puvodni.id, id);
      v.odberatelu++;
    }

    // ---- opt-outy (zrcadlo zdroje pro převedené odběratele) ----
    const povinne = new Set(
      (await trx.selectFrom('ik_kategorie').select(['id', 'povinna']).execute())
        .filter((k) => k.povinna)
        .map((k) => k.id),
    );
    const ids = [...odbVk.values()];
    if (ids.length) await trx.deleteFrom('ik_optouty').where('odberatel_id', 'in', ids).execute();
    const radky = new Map<string, { odberatel_id: string; kategorie_id: number }>();
    for (const op of data.optouty) {
      const odberatel_id = odbVk.get(op.subscriber_id);
      const kategorie_id = katVk.get(op.category_id);
      if (!odberatel_id || kategorie_id === undefined || povinne.has(kategorie_id)) continue;
      radky.set(`${odberatel_id}:${kategorie_id}`, { odberatel_id, kategorie_id });
    }
    const pole = [...radky.values()];
    for (let i = 0; i < pole.length; i += 500)
      await trx
        .insertInto('ik_optouty')
        .values(pole.slice(i, i + 500))
        .execute();
    v.optoutu = pole.length;

    // ---- historie hlášení ----
    const souhrny = new Map<number, SouhrnHlaseni>();
    for (const p of data.prijemci) {
      const s = souhrny.get(p.message_id) ?? { prijemcu: 0, odeslano: 0, sms: {}, email: {} };
      const stav = STAVY_PRIJEMCU[p.status] ?? p.status;
      const kanal = p.channel === 'email' ? s.email : s.sms;
      kanal[stav] = (kanal[stav] ?? 0) + Number(p.n);
      s.prijemcu += Number(p.n);
      if (stav === 'odeslano' || stav === 'doruceno') s.odeslano += Number(p.n);
      souhrny.set(p.message_id, s);
    }
    const hlaseniVk = new Map<number, string>(); // id VK → id platformy
    for (const h of data.hlaseni) {
      const s = souhrny.get(h.id) ?? { prijemcu: 0, odeslano: 0, sms: {}, email: {} };
      s.web_url = h.wp_url ?? null;
      const hotovo = h.status === 'done';
      if (!hotovo && h.status !== 'cancelled') {
        // naplánované/rozesílané ve VlastiKanálu se v platformě znovu NEROZESÍLAJÍ (zůstávají jako zrušené)
        s.puvodni_stav = h.status;
        v.hlaseniNedokoncenych++;
      }
      let cilDetail: string[] = [];
      if (h.target === 'villages') {
        try {
          const d = JSON.parse(h.target_detail ?? '[]') as unknown;
          if (Array.isArray(d)) cilDetail = d.map(String);
        } catch {
          /* neplatný JSON — prázdný seznam */
        }
      }
      const hodnoty = {
        autor_id: h.author_user_id ? (ucty.get(Number(h.author_user_id)) ?? null) : null,
        kategorie_id: katVk.get(h.category_id) ?? hlaseniKat,
        krizove: !!h.is_crisis,
        cil: h.target === 'villages' ? 'casti' : h.target === 'custom' ? 'vybrani' : 'vse',
        cil_detail: JSON.stringify(cilDetail),
        sms_text: h.sms_text || null,
        email_predmet: h.email_subject || null,
        email_text: h.email_body || null,
        email_html: h.email_html || null,
        clanek_titulek: h.web_title || null,
        clanek_html: h.web_html || h.web_body || null,
        stav: (hotovo ? 'hotovo' : 'zruseno') as 'hotovo' | 'zruseno',
        naplanovano_na: casVk(h.scheduled_at),
        zdroj_automatu: h.auto_source ? (AUTOMATY[h.auto_source] ?? h.auto_source) : null,
        vytvoreno_at: casVk(h.created_at) ?? new Date(),
        dokonceno_at: casVk(h.finished_at) ?? casVk(h.created_at),
        prevod_id: h.id,
        souhrn: JSON.stringify(s),
      };
      const ex = await trx
        .selectFrom('ik_hlaseni')
        .select('id')
        .where('prevod_id', '=', h.id)
        .executeTakeFirst();
      if (ex) {
        await trx.updateTable('ik_hlaseni').set(hodnoty).where('id', '=', ex.id).execute();
        hlaseniVk.set(h.id, ex.id);
      } else {
        const r = await trx
          .insertInto('ik_hlaseni')
          .values(hodnoty)
          .returning('id')
          .executeTakeFirstOrThrow();
        hlaseniVk.set(h.id, r.id);
        v.hlaseniNovych++;
      }
      v.hlaseni++;
    }

    // ---- automatické výstrahy (aby automat po spuštění znovu neohlásil, co VlastiKanál už rozeslal) ----
    // Idempotence přes detail.prevod_id (id ve VlastiKanálu). Událost, kterou už zapsal automat platformy
    // (stejný zdroj + externí id, bez prevod_id), se nepřevádí — byla by dvakrát.
    for (const w of data.vystrahy ?? []) {
      const stav = STAVY_VYSTRAH[w.status] ?? 'zahozeno';
      const hodnoty = {
        zdroj: w.source as 'chmu' | 'cez' | 'scvk',
        externi_id: w.ext_key,
        stupen: w.level ?? null,
        titulek: w.title,
        plati_od: casVk(w.valid_from),
        plati_do: casVk(w.valid_to),
        sms_text: w.sms_text ?? null,
        email_predmet: w.email_subject ?? null,
        email_text: w.email_body ?? null,
        detail: JSON.stringify({ ...detailVystrahy(w, volby.kodObce), prevod_id: w.id }),
        stav,
        hlaseni_id: w.message_id ? (hlaseniVk.get(w.message_id) ?? null) : null,
        pripomenuto_at: casVk(w.reminded_at),
        zruseno_at: casVk(w.cancelled_at),
        rozhodl_id: w.decided_user_id ? (ucty.get(Number(w.decided_user_id)) ?? null) : null,
        rozhodnuto_at: casVk(w.decided_at),
        vytvoreno_at: casVk(w.created_at) ?? new Date(),
      };
      const ex = await trx
        .selectFrom('ik_vystrahy')
        .select(['id'])
        .where('zdroj', '=', hodnoty.zdroj)
        .where('externi_id', '=', w.ext_key)
        .where(sql<boolean>`(detail->>'prevod_id') = ${String(w.id)}`)
        .executeTakeFirst();
      if (ex) {
        await trx.updateTable('ik_vystrahy').set(hodnoty).where('id', '=', ex.id).execute();
      } else {
        const automat = await trx
          .selectFrom('ik_vystrahy')
          .select('id')
          .where('zdroj', '=', hodnoty.zdroj)
          .where('externi_id', '=', w.ext_key)
          .where(sql<boolean>`detail->>'prevod_id' IS NULL`)
          .executeTakeFirst();
        if (automat) {
          v.vystrahUzZnamych++;
          continue;
        }
        await trx.insertInto('ik_vystrahy').values(hodnoty).execute();
        v.vystrahNovych++;
      }
      v.vystrah++;
      if (hodnoty.hlaseni_id) v.vystrahSHlasenim++;
      v.vystrahPodleStavu[stav] = (v.vystrahPodleStavu[stav] ?? 0) + 1;
    }
    // stav zdrojů: poslední zpracovaný soubor ČHMÚ a poslední úspěchy (existující hodnoty platformy mají přednost)
    const kv = data.kv ?? {};
    for (const zdroj of ['chmu', 'cez', 'scvk']) {
      const ok = casVk(kv[`${zdroj}_ok`]);
      const razitko = zdroj === 'chmu' ? (kv.chmu_last ?? null) : null;
      if (!ok && !razitko) continue;
      await trx
        .insertInto('ik_vystrahy_zdroje')
        .values({ zdroj, posledni_ok: ok, razitko })
        .onConflict((oc) =>
          oc.column('zdroj').doUpdateSet({
            posledni_ok: sql`COALESCE(ik_vystrahy_zdroje.posledni_ok, excluded.posledni_ok)`,
            razitko: sql`COALESCE(ik_vystrahy_zdroje.razitko, excluded.razitko)`,
          }),
        )
        .execute();
    }
    await zapisAudit(trx, {
      akce: 'infokanal.prevod_vlastikanal',
      detail: { ...v, anonymizovano: !!volby.anonymizovat },
    });
  };

  if (volby.nanecisto) {
    // celý převod v transakci, která se na konci vrátí — počty jsou skutečné, v DB nezůstane nic
    await db
      .transaction()
      .execute(async (trx) => {
        await prace(trx as unknown as Db);
        throw new NanecistoKonec();
      })
      .catch((e) => {
        if (!(e instanceof NanecistoKonec)) throw e;
      });
  } else {
    await db.transaction().execute(async (trx) => prace(trx as unknown as Db));
  }
  return v;
}

class NanecistoKonec extends Error {}
