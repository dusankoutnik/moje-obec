// Plánované odstávky elektřiny ČEZ Distribuce — převod odpovědi neoficiálního API bezstavy.cz (z něj čerpá web
// ČEZ Distribuce i jejich banner pro obce) na vlastní tvar a české popisy termínů a dotčených míst.
//
// API: GET https://api.bezstavy.cz/cezd/api/inspecttown/<kód obce RÚIAN> →
//   { outages: null | […], outages_in_town: [{ id, announcement_key, opened_at, fix_expected_at, cancelled_at?,
//     addresses: { towns: [{ name, code, town_districts: [{ town_parts: [{ name, streets: [{ name, house_nums,
//     ev_nums, street_nums }] }] }], cadastral_territories: [{ name, code, plots: [{ plot }] }] }] } }],
//     outages_in_town_district?: […] }
// Časy jsou skutečné UTC (ověřeno proti PDF oznámení: 08:00Z = „od 9:00“ v zimním čase).
// PDF oznámení: https://cdn.bezstavy.cz/<announcement_key>.

export const CEZ_API = 'https://api.bezstavy.cz/cezd/api/inspecttown/';
export const CEZ_PDF = 'https://cdn.bezstavy.cz/';
/** obecná stránka ČEZ Distribuce o odstávkách (adresa z patičky oznámení), když obec nemá vlastní odkaz */
export const CEZ_WEB = 'https://www.cezdistribuce.cz/odstavky';

export interface UliceOdstavky {
  /** název ulice (u obcí bez ulic prázdný) */
  nazev: string;
  cislaPopisna: string[];
  cislaEvidencni: string[];
  /** čísla orientační / další čísla u ulice tak, jak je posílá ČEZ */
  dalsiCisla: string;
}

export interface CastOdstavky {
  /** část obce */
  nazev: string;
  ulice: UliceOdstavky[];
}

export interface ParcelyOdstavky {
  katastr: string;
  parcely: string[];
}

export interface Odstavka {
  id: string;
  od: Date;
  do: Date | null;
  zruseno: Date | null;
  /** odkaz na PDF oznámení ČEZ (jen odkaz — nic se nenačítá předem) */
  pdf: string | null;
  casti: CastOdstavky[];
  parcely: ParcelyOdstavky[];
}

interface ApiUlice {
  name?: string | null;
  house_nums?: string | null;
  ev_nums?: string | null;
  street_nums?: string | null;
}
interface ApiObec {
  name?: string;
  code?: number | string;
  town_districts?: { town_parts?: { name?: string; streets?: ApiUlice[] | null }[] | null }[] | null;
  cadastral_territories?: { name?: string; plots?: { plot?: string }[] | null }[] | null;
}
export interface ApiOdstavka {
  id?: string | number;
  announcement_key?: string | null;
  opened_at?: string | null;
  fix_expected_at?: string | null;
  cancelled_at?: string | null;
  addresses?: { towns?: ApiObec[] | null } | null;
}
export interface ApiOdpoved {
  outages?: unknown;
  outages_in_town?: ApiOdstavka[] | null;
  outages_in_town_district?: ApiOdstavka[] | null;
}

const cisla = (s: string | null | undefined) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function datum(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** bezpečný klíč PDF (jen relativní cesta na cdn.bezstavy.cz, žádné jiné domény ani „..“) */
function odkazPdf(klic: string | null | undefined): string | null {
  if (!klic || !/^[\w./-]+$/.test(klic) || klic.includes('..') || klic.startsWith('/')) return null;
  return CEZ_PDF + klic;
}

/** ověří tvar odpovědi API — jiný tvar (změna API, chybová stránka) je chyba, ne „žádné odstávky“ */
export function jeOdpovedApi(j: unknown): j is ApiOdpoved {
  return !!j && typeof j === 'object' && ('outages_in_town' in j || 'outages' in j);
}

/** převede odpověď API na odstávky v dané obci (adresy jiných obcí se vynechají), bez duplicit, podle začátku */
export function prevedOdpoved(odpoved: ApiOdpoved, kodObce: string): Odstavka[] {
  const vse = [...(odpoved.outages_in_town ?? []), ...(odpoved.outages_in_town_district ?? [])];
  const videne = new Set<string>();
  const vysledek: Odstavka[] = [];
  for (const o of vse) {
    if (!o || o.id === undefined || o.id === null) continue;
    const id = String(o.id);
    const od = datum(o.opened_at);
    if (!od || videne.has(id)) continue;
    videne.add(id);
    const casti: CastOdstavky[] = [];
    const parcely: ParcelyOdstavky[] = [];
    for (const obec of o.addresses?.towns ?? []) {
      if (String(obec.code ?? '') !== kodObce) continue;
      for (const d of obec.town_districts ?? [])
        for (const p of d.town_parts ?? []) {
          const ulice = (p.streets ?? []).map((s) => ({
            nazev: (s.name ?? '').trim(),
            cislaPopisna: cisla(s.house_nums),
            cislaEvidencni: cisla(s.ev_nums),
            dalsiCisla: (s.street_nums ?? '').trim(),
          }));
          casti.push({ nazev: (p.name ?? '').trim() || (obec.name ?? ''), ulice });
        }
      for (const k of obec.cadastral_territories ?? []) {
        const pp = (k.plots ?? []).map((x) => String(x.plot ?? '').trim()).filter(Boolean);
        if (pp.length) parcely.push({ katastr: (k.name ?? '').trim(), parcely: pp });
      }
    }
    vysledek.push({
      id,
      od,
      do: datum(o.fix_expected_at),
      zruseno: datum(o.cancelled_at),
      pdf: odkazPdf(o.announcement_key),
      casti,
      parcely,
    });
  }
  return vysledek.sort((a, b) => a.od.getTime() - b.od.getTime());
}

// ---- české popisy ----

const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

function castiPraha(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return {
    den: DNY[wd] ?? '',
    datum: `${Number(g('day'))}. ${Number(g('month'))}. ${g('year')}`,
    cas: `${Number(g('hour'))}:${g('minute')}`,
  };
}

/** „pátek 6. 11. 2026, 9:00–15:30“ (pražský čas); přes půlnoc „6. 11. 2026 22:00 – 7. 11. 2026 4:00“ */
export function terminOdstavky(od: Date, do_: Date | null): string {
  const a = castiPraha(od);
  if (!do_) return `od ${a.den} ${a.datum}, ${a.cas}`;
  const b = castiPraha(do_);
  if (a.datum === b.datum) return `${a.den} ${a.datum}, ${a.cas}–${b.cas}`;
  return `${a.den} ${a.datum} ${a.cas} – ${b.den} ${b.datum} ${b.cas}`;
}

/** krátké datum pro skryté doplnění odkazů („6. 11. 2026“) */
export function datumOdstavky(od: Date): string {
  return castiPraha(od).datum;
}

/** popis jedné ulice / bloku čísel: „Hlavní: č. p. 1, 2; č. ev. 6“ */
export function popisUlice(u: UliceOdstavky): string {
  const kusy: string[] = [];
  if (u.cislaPopisna.length) kusy.push(`č. p. ${u.cislaPopisna.join(', ')}`);
  if (u.cislaEvidencni.length) kusy.push(`č. ev. ${u.cislaEvidencni.join(', ')}`);
  if (u.dalsiCisla) kusy.push(u.dalsiCisla);
  const cisla = kusy.join('; ');
  if (!u.nazev) return cisla;
  return cisla ? `${u.nazev}: ${cisla}` : u.nazev;
}

/** počet dotčených odběrných míst (domy + pozemky) */
export function pocetMist(o: Odstavka): number {
  let n = 0;
  for (const c of o.casti)
    for (const u of c.ulice) {
      const cisel = u.cislaPopisna.length + u.cislaEvidencni.length;
      n += cisel || (u.dalsiCisla || u.nazev ? 1 : 0);
    }
  for (const p of o.parcely) n += p.parcely.length;
  return n;
}

/**
 * stručný popis dotčených míst pro titulku: části obce a ulice s nejvýš `max` čísly popisnými,
 * např. „Vlastibořice: č. p. 1, 2, 3, 11, 13, 30 a dalších 6; č. ev. 6“
 */
export function souhrnMist(o: Odstavka, max = 8): string {
  const radky: string[] = [];
  for (const c of o.casti) {
    const ulice = c.ulice.map((u) => {
      const zbyva = u.cislaPopisna.length - max;
      const kratka = zbyva > 0 ? { ...u, cislaPopisna: u.cislaPopisna.slice(0, max) } : u;
      let t = popisUlice(kratka);
      if (zbyva > 0) t = t.replace(/(č\. p\. [^;]*)/, `$1 a dalších ${zbyva}`);
      return t;
    });
    const telo = ulice.filter(Boolean).join(' · ');
    radky.push(telo ? `${c.nazev}: ${telo}` : c.nazev);
  }
  const pozemky = o.parcely.reduce((n, p) => n + p.parcely.length, 0);
  if (pozemky) radky.push(`${pozemky} ${pozemky === 1 ? 'pozemek' : pozemky < 5 ? 'pozemky' : 'pozemků'}`);
  return radky.join(' · ');
}
