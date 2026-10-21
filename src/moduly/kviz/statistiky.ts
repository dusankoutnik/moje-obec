// Statistiky hráčů kvízu pro správu (jen role spravce/admin): počty hráčů a tabulka hráčů se skóre.
// Záměrně bez kontaktů — u přihlášených jen přezdívka účtu, u anonymních pořadové číslo hráče.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { skoreZ, type Skore } from './sluzba.js';

export const NA_STRANKU = 50;
/** nejsilnější oblast se počítá až od tolika odpovědí v oblasti (dřív je to náhoda) */
export const MIN_ODPOVEDI_OBLAST = 3;

export const RAZENI = ['hrac', 'odpovedi', 'skore', 'reset', 'posledni'] as const;
export type Razeni = (typeof RAZENI)[number];
export type Smer = 'asc' | 'desc';

/** výchozí směr po kliknutí na sloupec (čísla a datum sestupně, jméno vzestupně) */
export const VYCHOZI_SMER: Record<Razeni, Smer> = {
  hrac: 'asc',
  odpovedi: 'desc',
  skore: 'desc',
  reset: 'desc',
  posledni: 'desc',
};

export function nactiRazeni(radit?: string, smer?: string): { radit: Razeni; smer: Smer } {
  const r = (RAZENI as readonly string[]).includes(radit ?? '') ? (radit as Razeni) : 'posledni';
  const s = smer === 'asc' || smer === 'desc' ? smer : VYCHOZI_SMER[r];
  return { radit: r, smer: s };
}

export interface Oblast {
  nazev: string;
  ikona: string;
  odpovedi: number;
  skore: Skore;
}

export interface RadekHrace {
  cislo: number;
  prihlaseny: boolean;
  /** přezdívka účtu (prázdná = účet bez přezdívky) */
  prezdivka: string;
  odpovedi: number;
  celkem: Skore;
  odResetu: Skore;
  oblibena: Oblast | null;
  nejsilnejsi: Oblast | null;
  posledni: Date;
}

const n = (x: unknown) => Number(x ?? 0);

export async function souhrnHracu(db: Db, ted = new Date()) {
  const r = await db
    .selectFrom('kviz_hraci')
    .select((eb) => [
      eb.fn.countAll<string>().as('vsichni'),
      eb.fn.countAll<string>().filterWhere('uzivatel_id', 'is not', null).as('ucty'),
      eb.fn
        .countAll<string>()
        .filterWhere('posledni_at', '>=', new Date(ted.getTime() - 7 * 86400_000))
        .as('d7'),
      eb.fn
        .countAll<string>()
        .filterWhere('posledni_at', '>=', new Date(ted.getTime() - 30 * 86400_000))
        .as('d30'),
    ])
    .executeTakeFirstOrThrow();
  const vsichni = n(r.vsichni);
  const ucty = n(r.ucty);
  return { vsichni, prihlaseni: ucty, anonymni: vsichni - ucty, aktivni7: n(r.d7), aktivni30: n(r.d30) };
}

export async function seznamHracu(
  db: Db,
  v: { radit: Razeni; smer: Smer; strana: number },
): Promise<RadekHrace[]> {
  const smer = v.smer === 'asc' ? sql`ASC` : sql`DESC`;
  // podíl správných; hráči bez odpovědí vždy na konci
  const poradi = {
    hrac: sql`(u.prezdivka IS NULL OR u.prezdivka = '') ${smer}, lower(u.prezdivka) ${smer}, h.cislo ${smer}`,
    odpovedi: sql`odpovedi ${smer}, h.cislo`,
    skore: sql`spravne::float / nullif(odpovedi, 0) ${smer} NULLS LAST, odpovedi DESC, h.cislo`,
    reset: sql`r_spravne::float / nullif(r_odpovedi, 0) ${smer} NULLS LAST, r_odpovedi DESC, h.cislo`,
    posledni: sql`h.posledni_at ${smer}, h.cislo`,
  }[v.radit];
  const r = await sql<{
    id: string;
    cislo: number;
    uzivatel_id: string | null;
    prezdivka: string | null;
    posledni_at: Date;
    odpovedi: string;
    spravne: string;
    r_odpovedi: string;
    r_spravne: string;
  }>`
    SELECT h.id, h.cislo, h.uzivatel_id, u.prezdivka, h.posledni_at,
           count(a.id) AS odpovedi,
           count(a.id) FILTER (WHERE a.spravne) AS spravne,
           count(a.id) FILTER (WHERE a.ts > coalesce(h.reset_at, '-infinity')) AS r_odpovedi,
           count(a.id) FILTER (WHERE a.spravne AND a.ts > coalesce(h.reset_at, '-infinity')) AS r_spravne
      FROM kviz_hraci h
      LEFT JOIN uzivatele u ON u.id = h.uzivatel_id
      LEFT JOIN kviz_odpovedi a ON a.hrac_id = h.id
     GROUP BY h.id, u.prezdivka
     ORDER BY ${poradi}
     LIMIT ${NA_STRANKU} OFFSET ${(Math.max(1, v.strana) - 1) * NA_STRANKU}`.execute(db);
  const ids = r.rows.map((x) => x.id);
  const oblasti = new Map<string, Oblast[]>();
  if (ids.length) {
    const o = await sql<{ hrac_id: string; nazev: string; ikona: string; pocet: string; spravne: string }>`
      SELECT a.hrac_id, k.nazev, k.ikona, count(*) AS pocet, count(*) FILTER (WHERE a.spravne) AS spravne
        FROM kviz_odpovedi a
        JOIN kviz_otazky o ON o.id = a.otazka_id
        JOIN kviz_kategorie k ON k.id = o.kategorie_id
       WHERE a.hrac_id = ANY(${ids}::uuid[])
       GROUP BY a.hrac_id, k.id`.execute(db);
    for (const x of o.rows) {
      const s = n(x.spravne);
      const p = n(x.pocet);
      const seznam = oblasti.get(x.hrac_id) ?? [];
      seznam.push({ nazev: x.nazev, ikona: x.ikona, odpovedi: p, skore: skoreZ(s, p - s) });
      oblasti.set(x.hrac_id, seznam);
    }
  }
  return r.rows.map((x) => {
    const o = oblasti.get(x.id) ?? [];
    const podleNazvu = (a: Oblast, b: Oblast) => a.nazev.localeCompare(b.nazev, 'cs');
    const oblibena = [...o].sort((a, b) => b.odpovedi - a.odpovedi || podleNazvu(a, b))[0] ?? null;
    const nejsilnejsi =
      o
        .filter((x) => x.odpovedi >= MIN_ODPOVEDI_OBLAST)
        .sort(
          (a, b) =>
            b.skore.spravne / b.odpovedi - a.skore.spravne / a.odpovedi ||
            b.odpovedi - a.odpovedi ||
            podleNazvu(a, b),
        )[0] ?? null;
    const s = n(x.spravne);
    const rs = n(x.r_spravne);
    return {
      cislo: x.cislo,
      prihlaseny: !!x.uzivatel_id,
      prezdivka: x.prezdivka ?? '',
      odpovedi: n(x.odpovedi),
      celkem: skoreZ(s, n(x.odpovedi) - s),
      odResetu: skoreZ(rs, n(x.r_odpovedi) - rs),
      oblibena,
      nejsilnejsi,
      posledni: new Date(x.posledni_at),
    };
  });
}
