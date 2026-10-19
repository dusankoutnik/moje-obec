// Akce z jiných aplikací obce (rezervace sálu a hřišť, předprodej vstupenek) v kalendáři webu.
// Zdroj: JSON z rezervačního systému (REZERVACE_KALENDAR_URL) — jen veřejné položky, bez jmen.
// Keš 10 min; když zdroj neodpoví, web jede dál s poslední známou verzí (nebo bez externích akcí).
// Opakované rezervace (série — např. jóga každý čtvrtek) se slučují do jedné položky s nejbližším termínem.
import type { FastifyBaseLogger } from 'fastify';
import { casPraha } from '../../lib/datum.js';

/** odkaz na akci: akce webu → její stránka, akce z rezervací → odkaz zdroje (předprodej) nebo nic */
export function odkazAkce(a: {
  externi?: boolean;
  slug?: string | null;
  url?: string | null;
}): string | null {
  if (a.externi || !a.slug) return a.url || null;
  return `/akce/${a.slug}`;
}

export interface ExterniAkce {
  id: string;
  externi: true;
  titulek: string;
  slug: null;
  url: string | null;
  perex: string;
  datum: Date;
  akce_konec: Date | null;
  akce_cely_den: boolean;
  akce_misto: string;
  /** u série: popis opakování, např. „každý čtvrtek“ */
  opakovani: string | null;
}

interface Polozka {
  id: string;
  typ: string;
  serie?: string | null;
  zdroj_nazev: string;
  datum: string;
  od: string | null;
  do: string | null;
  cely_den: boolean;
  nazev: string;
  popis?: string;
  odkaz?: string | null;
}

const DNY = ['v neděli', 'v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu'];
const KAZDY = [
  'každou neděli',
  'každé pondělí',
  'každé úterý',
  'každou středu',
  'každý čtvrtek',
  'každý pátek',
  'každou sobotu',
];

function cas(datum: string, hm: string | null): Date | null {
  if (!hm) return casPraha(datum);
  const [h, m] = hm.split(':').map(Number);
  return casPraha(datum, h ?? 0, m ?? 0);
}

export function prevedPolozky(polozky: Polozka[], ted = new Date()): ExterniAkce[] {
  const vysledek: ExterniAkce[] = [];
  const videneSerie = new Set<string>();
  const serazene = [...polozky].sort((a, b) =>
    (a.datum + (a.od ?? '')).localeCompare(b.datum + (b.od ?? '')),
  );
  for (const p of serazene) {
    const zacatek = cas(p.datum, p.cely_den ? null : p.od);
    if (!zacatek) continue;
    const konec = p.cely_den ? casPraha(p.datum, 23, 59) : p.do ? cas(p.datum, p.do) : null;
    if ((konec ?? zacatek) < ted) continue; // proběhlé
    if (p.serie) {
      if (videneSerie.has(p.serie)) continue;
      videneSerie.add(p.serie);
    }
    const den = new Date(Date.parse(p.datum + 'T12:00:00Z')).getUTCDay();
    vysledek.push({
      id: p.id,
      externi: true,
      titulek: p.nazev,
      slug: null,
      url: p.odkaz ?? null,
      perex: p.popis ?? '',
      datum: zacatek,
      akce_konec: p.cely_den ? null : konec,
      akce_cely_den: p.cely_den,
      akce_misto: p.zdroj_nazev,
      opakovani: p.serie
        ? `${KAZDY[den]}${p.od && p.do ? ` ${p.od}–${p.do}` : ''}, nejbližší ${DNY[den]}`
        : null,
    });
  }
  return vysledek;
}

export class ExterniKalendar {
  private kes: { cas: number; akce: Polozka[] } | null = null;
  constructor(
    private url: string | undefined,
    private log: FastifyBaseLogger,
  ) {}

  async akce(ted = new Date()): Promise<ExterniAkce[]> {
    if (!this.url) return [];
    if (!this.kes || Date.now() - this.kes.cas > 10 * 60_000) {
      try {
        const r = await fetch(this.url, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { polozky?: Polozka[] };
        this.kes = { cas: Date.now(), akce: Array.isArray(j.polozky) ? j.polozky : [] };
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'kalendář rezervací nedostupný');
        // poslední známá data ponecháme, další pokus za minutu
        this.kes = { cas: Date.now() - 9 * 60_000, akce: this.kes?.akce ?? [] };
      }
    }
    return prevedPolozky(this.kes.akce, ted);
  }
}
