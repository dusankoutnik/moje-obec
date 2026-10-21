// Kvíz — doménová logika bez HTTP: hráči (účet / anonymní cookie), výběr a zodpovězení otázky, skóre, správa.
import { sql, type Selectable } from 'kysely';
import type { Db } from '../../db/index.js';
import type { KvizHraciTable, Uzivatel } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { DELKA_KOLA, posunPoKole, vyberOtazku, zamichej, type Kandidat } from './vyber.js';

export type Hrac = Selectable<KvizHraciTable>;

export const PISMENA = ['A', 'B', 'C', 'D'] as const;
const JE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Skore {
  spravne: number;
  spatne: number;
  /** celé procento, null = zatím žádná odpověď */
  procento: number | null;
}

export function skoreZ(spravne: number, spatne: number): Skore {
  const n = spravne + spatne;
  return { spravne, spatne, procento: n ? Math.round((spravne / n) * 100) : null };
}

/**
 * Návrh obtížnosti podle podílu hráčů, kteří odpověděli správně napoprvé (pro kalibraci banky).
 * Až od 10 hráčů — dřív je to šum.
 */
export function navrhObtiznosti(hracu: number, napoprveSpravne: number): number | null {
  if (hracu < 10) return null;
  const p = napoprveSpravne / hracu;
  if (p >= 0.85) return 1;
  if (p >= 0.7) return 2;
  if (p >= 0.5) return 3;
  if (p >= 0.3) return 4;
  return 5;
}

const n = (x: unknown) => Number(x ?? 0);

export class KvizSluzba {
  constructor(private db: Db) {}

  /** kategorie s počtem aktivních otázek (jen neprázdné), v pevném pořadí */
  async kategorie() {
    const r = await sql<{ slug: string; nazev: string; ikona: string; pocet: string }>`
      SELECT k.slug, k.nazev, k.ikona, count(o.id) AS pocet
        FROM kviz_kategorie k
        JOIN kviz_otazky o ON o.kategorie_id = k.id AND o.v_baliku AND o.vypnuta_at IS NULL
       GROUP BY k.id
       ORDER BY k.poradi, k.nazev`.execute(this.db);
    return r.rows.map((k) => ({ ...k, pocet: n(k.pocet) }));
  }

  // ---------- hráči ----------

  async zalozHrace(uzivatelId: string | null): Promise<Hrac> {
    return this.db
      .insertInto('kviz_hraci')
      .values({ uzivatel_id: uzivatelId, otazka_id: null, poradi: null })
      .onConflict((oc) => oc.column('uzivatel_id').doUpdateSet({ posledni_at: new Date() }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Hráč pro požadavek: přihlášený = hráč účtu; jinak anonymní podle cookie. Má-li přihlášený v prohlížeči
   * ještě anonymní cookie, anonymní skóre se připojí k účtu (a cookie se má smazat).
   */
  async najdiHrace(v: {
    uzivatelId: string | null;
    cookieId: string | null;
  }): Promise<{ hrac: Hrac | null; smazatCookie: boolean }> {
    const cookieId = v.cookieId && JE_UUID.test(v.cookieId) ? v.cookieId : null;
    if (!v.uzivatelId) {
      if (!cookieId) return { hrac: null, smazatCookie: !!v.cookieId };
      const h = await this.db
        .selectFrom('kviz_hraci')
        .selectAll()
        .where('id', '=', cookieId)
        .where('uzivatel_id', 'is', null)
        .executeTakeFirst();
      return { hrac: h ?? null, smazatCookie: !h };
    }
    const uzivatelId = v.uzivatelId;
    const hrac = await this.db.transaction().execute(async (trx) => {
      let ucet = await trx
        .selectFrom('kviz_hraci')
        .selectAll()
        .where('uzivatel_id', '=', uzivatelId)
        .forUpdate()
        .executeTakeFirst();
      if (!cookieId) return ucet ?? null;
      const anon = await trx
        .selectFrom('kviz_hraci')
        .selectAll()
        .where('id', '=', cookieId)
        .where('uzivatel_id', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!anon) return ucet ?? null;
      if (!ucet) {
        // účet ještě nehrál: anonymní hráč se stane hráčem účtu (i s rozehranou otázkou)
        return trx
          .updateTable('kviz_hraci')
          .set({ uzivatel_id: uzivatelId, posledni_at: new Date() })
          .where('id', '=', anon.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await trx
        .updateTable('kviz_odpovedi')
        .set({ hrac_id: ucet.id })
        .where('hrac_id', '=', anon.id)
        .execute();
      if (!ucet.otazka_id && anon.otazka_id) {
        // účet nic nerozehrál → pokračuje tam, kde anonymní hra skončila
        ucet = await trx
          .updateTable('kviz_hraci')
          .set({
            otazka_id: anon.otazka_id,
            poradi: anon.poradi,
            odpoved_id: anon.odpoved_id,
            kategorie: anon.kategorie,
            kolo: anon.kolo,
            kolo_od: anon.kolo_od,
            krok: anon.krok,
            kolo_spravne: anon.kolo_spravne,
            posun: anon.posun,
            posledni_at: new Date(),
          })
          .where('id', '=', ucet.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      // anonymní hráč je po přesunu odpovědí jen prázdná technická položka
      await trx.deleteFrom('kviz_hraci').where('id', '=', anon.id).execute();
      return ucet;
    });
    return { hrac, smazatCookie: !!v.cookieId };
  }

  private async hracNaZapis(trx: Db, id: string) {
    return trx.selectFrom('kviz_hraci').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  }

  // ---------- hra ----------

  /** nová hra se zvolenými kategoriemi (neznámé slugy se zahodí; prázdné = všechny) → první otázka */
  async zacni(hracId: string, kategorie: string[]): Promise<Hrac | null> {
    const zname = new Set((await this.kategorie()).map((k) => k.slug));
    const zvolene = [...new Set(kategorie.filter((k) => zname.has(k)))];
    await this.db
      .updateTable('kviz_hraci')
      .set((eb) => ({
        kategorie: zvolene.length === zname.size ? [] : zvolene,
        kolo: eb
          .case()
          .when('krok', '>', 0)
          .then(eb('kolo', '+', 1))
          .else(eb.ref('kolo'))
          .end(),
        krok: 0,
        kolo_spravne: 0,
        kolo_od: new Date(),
        otazka_id: null,
        poradi: null,
        odpoved_id: null,
      }))
      .where('id', '=', hracId)
      .execute();
    return this.dalsi(hracId);
  }

  /** vybere další otázku (po dokončeném kole začne nové s posunem obtížnosti) */
  async dalsi(hracId: string, nahoda: () => number = Math.random): Promise<Hrac | null> {
    return this.db.transaction().execute(async (trx) => {
      let h = await this.hracNaZapis(trx, hracId);
      if (!h) return null;
      if (h.krok >= DELKA_KOLA) {
        h = await trx
          .updateTable('kviz_hraci')
          .set({
            posun: posunPoKole(h.kolo_spravne, h.krok),
            kolo: h.kolo + 1,
            krok: 0,
            kolo_spravne: 0,
            kolo_od: new Date(),
          })
          .where('id', '=', h.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      const kandidati = await this.kandidati(trx, h);
      const vynechat = new Set(
        (
          await trx
            .selectFrom('kviz_odpovedi')
            .select('otazka_id')
            .distinct()
            .where('hrac_id', '=', h.id)
            .where('ts', '>=', h.kolo_od)
            .execute()
        ).map((r) => r.otazka_id),
      );
      const posledniKategorie = h.otazka_id ? kandidati.find((k) => k.id === h!.otazka_id)?.kategorie : null;
      const vybrana = vyberOtazku(
        kandidati,
        { krok: h.krok, posun: h.posun, posledniKategorie, vynechat, aktualni: h.otazka_id },
        nahoda,
      );
      return trx
        .updateTable('kviz_hraci')
        .set({
          otazka_id: vybrana?.id ?? null,
          poradi: vybrana ? zamichej(4, nahoda) : null,
          odpoved_id: null,
          posledni_at: new Date(),
        })
        .where('id', '=', h.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  private async kandidati(db: Db, h: Hrac): Promise<Kandidat[]> {
    const filtr = h.kategorie.length ? sql`AND k.slug = ANY(${h.kategorie})` : sql``;
    const r = await sql<{
      id: string;
      kategorie: string;
      obtiznost: number;
      videna: string;
      posledni: boolean | null;
      posledni_at: Date | null;
    }>`
      SELECT o.id, k.slug AS kategorie, o.obtiznost,
             count(a.id) AS videna,
             (array_agg(a.spravne ORDER BY a.ts DESC) FILTER (WHERE a.id IS NOT NULL))[1] AS posledni,
             max(a.ts) AS posledni_at
        FROM kviz_otazky o
        JOIN kviz_kategorie k ON k.id = o.kategorie_id
        LEFT JOIN kviz_odpovedi a ON a.otazka_id = o.id AND a.hrac_id = ${h.id}
       WHERE o.v_baliku AND o.vypnuta_at IS NULL ${filtr}
       GROUP BY o.id, k.slug`.execute(db);
    return r.rows.map((o) => ({
      id: o.id,
      kategorie: o.kategorie,
      obtiznost: o.obtiznost,
      videna: n(o.videna),
      posledniSpravne: o.posledni,
      posledniAt: o.posledni_at ? new Date(o.posledni_at).getTime() : null,
    }));
  }

  /** rozehraná (nezodpovězená) otázka s odpověďmi v zamíchaném pořadí */
  async rozehrana(h: Hrac) {
    if (!h.otazka_id || !h.poradi || h.odpoved_id) return null;
    const o = await this.otazkaSKategorii(h.otazka_id);
    if (!o) return null;
    return {
      ...o,
      nabidka: h.poradi.map((i, pozice) => ({ pozice, pismeno: PISMENA[pozice]!, text: o.odpovedi[i]! })),
    };
  }

  private otazkaSKategorii(id: string) {
    return this.db
      .selectFrom('kviz_otazky as o')
      .innerJoin('kviz_kategorie as k', 'k.id', 'o.kategorie_id')
      .select([
        'o.id',
        'o.otazka',
        'o.odpovedi',
        'o.obtiznost',
        'o.vysvetleni',
        'o.zdroj',
        'k.slug as kategorie',
        'k.nazev as kategorie_nazev',
        'k.ikona as kategorie_ikona',
      ])
      .where('o.id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Zodpovězení rozehrané otázky. `pozice` = pořadí tlačítka na stránce (0–3). Odpověď na jinou než rozehranou
   * otázku (stará záložka, dvojklik) se nepočítá → 'neplatne'.
   */
  async odpovez(hracId: string, otazkaId: string, pozice: number): Promise<'ok' | 'neplatne'> {
    return this.db.transaction().execute(async (trx) => {
      const h = await this.hracNaZapis(trx, hracId);
      if (!h || !h.poradi || h.odpoved_id || h.otazka_id !== otazkaId) return 'neplatne';
      if (!Number.isInteger(pozice) || pozice < 0 || pozice >= h.poradi.length) return 'neplatne';
      const zvolena = h.poradi[pozice]!;
      const spravne = zvolena === 0;
      const a = await trx
        .insertInto('kviz_odpovedi')
        .values({ hrac_id: h.id, otazka_id: otazkaId, zvolena, spravne })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('kviz_hraci')
        .set({
          odpoved_id: a.id,
          krok: h.krok + 1,
          kolo_spravne: h.kolo_spravne + (spravne ? 1 : 0),
          posledni_at: new Date(),
        })
        .where('id', '=', h.id)
        .execute();
      return 'ok';
    });
  }

  /** výsledek poslední odpovědi na rozehranou otázku (stránka po odpovědi) */
  async vysledek(h: Hrac) {
    if (!h.otazka_id || !h.odpoved_id || !h.poradi) return null;
    const a = await this.db
      .selectFrom('kviz_odpovedi')
      .select(['zvolena', 'spravne'])
      .where('id', '=', String(h.odpoved_id))
      .executeTakeFirst();
    const o = await this.otazkaSKategorii(h.otazka_id);
    if (!a || !o) return null;
    return {
      ...o,
      spravne: a.spravne,
      zvolena: a.zvolena,
      // odpovědi ve stejném pořadí, v jakém je hráč viděl
      nabidka: h.poradi.map((i, pozice) => ({
        pozice,
        pismeno: PISMENA[pozice]!,
        text: o.odpovedi[i]!,
        spravna: i === 0,
        zvolena: i === a.zvolena,
      })),
      konecKola: h.krok >= DELKA_KOLA,
      kolo: h.kolo,
      koloSpravne: h.kolo_spravne,
      dalsiPosun: h.krok >= DELKA_KOLA ? posunPoKole(h.kolo_spravne, h.krok) : 0,
    };
  }

  /** průběžné skóre od posledního resetu */
  async skore(h: Hrac): Promise<Skore> {
    let q = this.db
      .selectFrom('kviz_odpovedi')
      .select((eb) => [
        eb.fn.countAll<string>().filterWhere('spravne', '=', true).as('spravne'),
        eb.fn.countAll<string>().filterWhere('spravne', '=', false).as('spatne'),
      ])
      .where('hrac_id', '=', h.id);
    if (h.reset_at) q = q.where('ts', '>', h.reset_at);
    const r = await q.executeTakeFirstOrThrow();
    return skoreZ(n(r.spravne), n(r.spatne));
  }

  /** skóre po kategoriích: celkově i od posledního resetu (všechny kategorie s otázkami nebo odpověďmi) */
  async skorePoKategoriich(h: Hrac) {
    const reset = h.reset_at ?? new Date(0);
    const r = await sql<{
      slug: string;
      nazev: string;
      ikona: string;
      cs: string;
      cx: string;
      rs: string;
      rx: string;
    }>`
      SELECT k.slug, k.nazev, k.ikona,
             count(a.id) FILTER (WHERE a.spravne) AS cs,
             count(a.id) FILTER (WHERE NOT a.spravne) AS cx,
             count(a.id) FILTER (WHERE a.spravne AND a.ts > ${reset}) AS rs,
             count(a.id) FILTER (WHERE NOT a.spravne AND a.ts > ${reset}) AS rx
        FROM kviz_kategorie k
        LEFT JOIN kviz_otazky o ON o.kategorie_id = k.id
        LEFT JOIN kviz_odpovedi a ON a.otazka_id = o.id AND a.hrac_id = ${h.id}
       GROUP BY k.id
      HAVING count(a.id) > 0 OR count(o.id) FILTER (WHERE o.v_baliku AND o.vypnuta_at IS NULL) > 0
       ORDER BY k.poradi, k.nazev`.execute(this.db);
    const radky = r.rows.map((k) => ({
      slug: k.slug,
      nazev: k.nazev,
      ikona: k.ikona,
      celkem: skoreZ(n(k.cs), n(k.cx)),
      odResetu: skoreZ(n(k.rs), n(k.rx)),
    }));
    const soucet = (f: 'celkem' | 'odResetu') =>
      skoreZ(
        radky.reduce((s, x) => s + x[f].spravne, 0),
        radky.reduce((s, x) => s + x[f].spatne, 0),
      );
    return { radky, celkem: soucet('celkem'), odResetu: soucet('odResetu') };
  }

  async reset(hracId: string): Promise<void> {
    await this.db
      .updateTable('kviz_hraci')
      .set({ reset_at: new Date(), posledni_at: new Date() })
      .where('id', '=', hracId)
      .execute();
  }

  // ---------- správa ----------

  async prehledSpravy() {
    const r = await sql<{
      slug: string;
      nazev: string;
      ikona: string;
      aktivni: string;
      vypnute: string;
      mimo: string;
      odpovedi: string;
      spravne: string;
      hracu: string;
    }>`
      SELECT k.slug, k.nazev, k.ikona,
             count(o.id) FILTER (WHERE o.v_baliku AND o.vypnuta_at IS NULL) AS aktivni,
             count(o.id) FILTER (WHERE o.vypnuta_at IS NOT NULL) AS vypnute,
             count(o.id) FILTER (WHERE NOT o.v_baliku) AS mimo,
             coalesce(sum(st.odpovedi), 0) AS odpovedi,
             coalesce(sum(st.spravne), 0) AS spravne,
             (SELECT count(DISTINCT a.hrac_id) FROM kviz_odpovedi a JOIN kviz_otazky o2 ON o2.id = a.otazka_id
               WHERE o2.kategorie_id = k.id) AS hracu
        FROM kviz_kategorie k
        LEFT JOIN kviz_otazky o ON o.kategorie_id = k.id
        LEFT JOIN (SELECT otazka_id, count(*) AS odpovedi, count(*) FILTER (WHERE spravne) AS spravne
                     FROM kviz_odpovedi GROUP BY otazka_id) st ON st.otazka_id = o.id
       GROUP BY k.id
       ORDER BY k.poradi, k.nazev`.execute(this.db);
    const kategorie = r.rows.map((k) => ({
      slug: k.slug,
      nazev: k.nazev,
      ikona: k.ikona,
      aktivni: n(k.aktivni),
      vypnute: n(k.vypnute),
      mimo: n(k.mimo),
      hracu: n(k.hracu),
      odpovedi: n(k.odpovedi),
      skore: skoreZ(n(k.spravne), n(k.odpovedi) - n(k.spravne)),
    }));
    const hraci = await this.db
      .selectFrom('kviz_hraci')
      .select((eb) => [
        eb.fn.countAll<string>().as('vsichni'),
        eb.fn.countAll<string>().filterWhere('uzivatel_id', 'is not', null).as('ucty'),
      ])
      .executeTakeFirstOrThrow();
    return { kategorie, hracu: n(hraci.vsichni), hracuSUctem: n(hraci.ucty) };
  }

  async otazkySpravy(slug: string) {
    const k = await this.db
      .selectFrom('kviz_kategorie')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (!k) return null;
    const r = await sql<{
      id: string;
      otazka: string;
      odpovedi: string[];
      obtiznost: number;
      zdroj: string;
      balik: string;
      v_baliku: boolean;
      vypnuta_at: Date | null;
      pocet: string;
      spravne: string;
      hracu: string;
      napoprve: string;
    }>`
      WITH a AS (
        SELECT a.* FROM kviz_odpovedi a JOIN kviz_otazky o ON o.id = a.otazka_id WHERE o.kategorie_id = ${k.id}
      ), prvni AS (
        SELECT DISTINCT ON (hrac_id, otazka_id) otazka_id, spravne FROM a ORDER BY hrac_id, otazka_id, ts
      )
      SELECT o.id, o.otazka, o.odpovedi, o.obtiznost, o.zdroj, o.balik, o.v_baliku, o.vypnuta_at,
             coalesce(st.pocet, 0) AS pocet, coalesce(st.spravne, 0) AS spravne,
             coalesce(p.hracu, 0) AS hracu, coalesce(p.napoprve, 0) AS napoprve
        FROM kviz_otazky o
        LEFT JOIN (SELECT otazka_id, count(*) AS pocet, count(*) FILTER (WHERE spravne) AS spravne
                     FROM a GROUP BY otazka_id) st ON st.otazka_id = o.id
        LEFT JOIN (SELECT otazka_id, count(*) AS hracu, count(*) FILTER (WHERE spravne) AS napoprve
                     FROM prvni GROUP BY otazka_id) p ON p.otazka_id = o.id
       WHERE o.kategorie_id = ${k.id}
       ORDER BY o.v_baliku DESC, o.obtiznost, o.id`.execute(this.db);
    return {
      kategorie: k,
      otazky: r.rows.map((o) => {
        const hracu = n(o.hracu);
        const napoprve = n(o.napoprve);
        return {
          ...o,
          pocet: n(o.pocet),
          spravne: n(o.spravne),
          hracu,
          napoprve: hracu ? Math.round((napoprve / hracu) * 100) : null,
          navrh: navrhObtiznosti(hracu, napoprve),
          stav: !o.v_baliku ? ('mimo' as const) : o.vypnuta_at ? ('vypnuta' as const) : ('aktivni' as const),
        };
      }),
    };
  }

  /** vypnutí / zapnutí otázky úřadem; vrací kategorii otázky (kam se vrátit) */
  async prepniOtazku(id: string, zapnout: boolean, aktor: Uzivatel, ip?: string | null) {
    const o = await this.db
      .updateTable('kviz_otazky')
      .set({ vypnuta_at: zapnout ? null : new Date(), aktualizovano_at: new Date() })
      .where('id', '=', id)
      .returning(['id', 'kategorie_id'])
      .executeTakeFirst();
    if (!o) return null;
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: zapnout ? 'kviz.otazka_zapnuta' : 'kviz.otazka_vypnuta',
      detail: { otazka: id },
      ip,
    });
    const k = await this.db
      .selectFrom('kviz_kategorie')
      .select('slug')
      .where('id', '=', o.kategorie_id)
      .executeTakeFirstOrThrow();
    return k.slug;
  }
}
