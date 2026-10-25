// Převod odpovědi MET Norway Locationforecast 2.0 (compact) na hodinovou a denní předpověď „po česku“.
// Odpověď: properties.timeseries[] s časem (UTC), okamžitými hodnotami (teplota, vítr) a souhrny na další 1, 6
// a 12 hodin (symbol, srážky). Hodinová data jsou na ~2–3 dny, dál po šesti hodinách do ~9 dnů.
// Den = místní kalendářní den Europe/Prague (správně přes změnu času).

export const MET_API = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
export const MET_WEB = 'https://www.yr.no/';
export const MET_LICENCE = 'https://api.met.no/doc/License';
const PASMO = 'Europe/Prague';

export interface MetBod {
  time: string;
  data: {
    instant: { details: { air_temperature?: number; wind_speed?: number; [k: string]: number | undefined } };
    next_1_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number } };
    next_6_hours?: { summary: { symbol_code: string }; details?: { precipitation_amount?: number } };
    next_12_hours?: { summary: { symbol_code: string }; details?: Record<string, number> };
  };
}
export interface MetOdpoved {
  /** [lon, lat, nadmořská výška bodu předpovědi v m] */
  geometry?: { coordinates?: number[] };
  properties: { meta?: { updated_at?: string }; timeseries: MetBod[] };
}

export function jeOdpovedMet(j: unknown): j is MetOdpoved {
  const ts = (j as MetOdpoved | null)?.properties?.timeseries;
  return (
    Array.isArray(ts) &&
    ts.length > 0 &&
    ts.every((b) => typeof b?.time === 'string' && typeof b?.data?.instant?.details === 'object')
  );
}

// ---------- české popisy symbolů ----------
const ZAKLAD: Record<string, string> = {
  clearsky: 'jasno',
  fair: 'skoro jasno',
  partlycloudy: 'polojasno',
  cloudy: 'zataženo',
  fog: 'mlha',
  lightrain: 'slabý déšť',
  rain: 'déšť',
  heavyrain: 'silný déšť',
  lightrainshowers: 'slabé dešťové přeháňky',
  rainshowers: 'dešťové přeháňky',
  heavyrainshowers: 'silné dešťové přeháňky',
  lightsleet: 'slabý déšť se sněhem',
  sleet: 'déšť se sněhem',
  heavysleet: 'silný déšť se sněhem',
  lightsleetshowers: 'slabé přeháňky deště se sněhem',
  sleetshowers: 'přeháňky deště se sněhem',
  heavysleetshowers: 'silné přeháňky deště se sněhem',
  lightsnow: 'slabé sněžení',
  snow: 'sněžení',
  heavysnow: 'silné sněžení',
  lightsnowshowers: 'slabé sněhové přeháňky',
  snowshowers: 'sněhové přeháňky',
  heavysnowshowers: 'silné sněhové přeháňky',
};

/** symbol_code bez překlepu MET (ikony „lightssleet…“ — API i soubory v public/img/pocasi mají „lightsleet…“) */
export function normalizujSymbol(s: string): string {
  const x = s.replace(/^lightss/, 'lights');
  return /^[a-z_]+$/.test(x) ? x : 'cloudy';
}

/** český popis symbolu („déšť a bouřky“); neznámý symbol = obecný popis */
export function popisSymbolu(symbol: string): string {
  const zaklad = normalizujSymbol(symbol).replace(/_(day|night|polartwilight)$/, '');
  const bourka = zaklad.endsWith('andthunder');
  const bez = bourka ? zaklad.slice(0, -'andthunder'.length) : zaklad;
  const p = ZAKLAD[bez];
  if (!p) return 'počasí bez popisu';
  return bourka ? `${p} a bouřky` : p;
}

/** denní varianta symbolu (ikona dne místo noční) */
export const denniSymbol = (s: string) => normalizujSymbol(s).replace(/_(night|polartwilight)$/, '_day');

// ---------- místní čas ----------
const fmtDen = new Intl.DateTimeFormat('en-CA', {
  timeZone: PASMO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const fmtHodina = new Intl.DateTimeFormat('en-GB', { timeZone: PASMO, hour: '2-digit', hourCycle: 'h23' });
/** místní datum RRRR-MM-DD */
export const mistniDen = (d: Date) => fmtDen.format(d);
/** místní hodina 0–23 */
export const mistniHodina = (d: Date) => Number(fmtHodina.format(d));

// ---------- převod ----------
export interface Hodina {
  cas: Date;
  teplota: number | null;
  /** srážky za následující hodinu (mm) */
  srazky: number | null;
  symbol: string | null;
  popis: string;
  /** vítr km/h */
  vitr: number | null;
  /** oblačnost 0–100 % (cloud_area_fraction) — kolik mraků kreslí scéna dlaždice */
  oblacnost?: number | null;
}

export interface Den {
  /** místní datum RRRR-MM-DD */
  datum: string;
  /** začátek dne (pro formátování) */
  cas: Date;
  max: number | null;
  min: number | null;
  /** součet srážek (mm, zaokrouhleno na desetiny) */
  srazky: number;
  symbol: string;
  popis: string;
  /** nejvyšší vítr přes den km/h */
  vitrMax: number | null;
  /** den neobsahuje celých 24 h (dnešek) */
  castecny: boolean;
}

export interface Predpoved {
  /** aktuální (nejbližší) hodina */
  ted: Hodina | null;
  /** hodinová předpověď od aktuální hodiny, nejvýš 48 h */
  hodiny: Hodina[];
  /** denní souhrny od dneška, nejvýš 7 dní */
  dny: Den[];
  /** čas výpočtu modelu MET (meta.updated_at) */
  modelZ: Date | null;
  /** drobné údaje pod nadpisem dlaždice (2026-10-23, Dušan) */
  podminky: Podminky;
}

export interface Podminky {
  /** nadmořská výška bodu předpovědi z MET (profil obce ji může přepsat) */
  vyska: number | null;
  /** tlak přepočtený na hladinu moře, hPa */
  tlak: number | null;
  /** změna tlaku v příštích 3 hodinách (hPa) a slovní trend */
  tlakZmena3h: number | null;
  tlakTrend: 'rychle-stoupa' | 'stoupa' | 'stali' | 'klesa' | 'rychle-klesa' | null;
  vlhkost: number | null;
  /** odkud vítr vane: S, SV, V, JV, J, JZ, Z, SZ */
  smerVetru: string | null;
}

const SMERY = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
export function smerVetru(stupne: number | null): string | null {
  if (stupne === null) return null;
  return SMERY[Math.round((((stupne % 360) + 360) % 360) / 45) % 8]!;
}
/** trend tlaku za 3 h podle běžných meteorologických prahů (≥ 3 hPa = rychlá změna) */
export function trendTlaku(zmena: number | null): Podminky['tlakTrend'] {
  if (zmena === null) return null;
  if (zmena <= -3) return 'rychle-klesa';
  if (zmena <= -1) return 'klesa';
  if (zmena >= 3) return 'rychle-stoupa';
  if (zmena >= 1) return 'stoupa';
  return 'stali';
}

const kmh = (ms: number | undefined) => (typeof ms === 'number' ? Math.round(ms * 3.6) : null);
const cislo = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const HODINA = 3600_000;

/** převede odpověď MET na předpověď z pohledu času `ted` */
export function prevedMet(j: MetOdpoved, ted: Date, volby: { hodin?: number; dnu?: number } = {}): Predpoved {
  const hodin = volby.hodin ?? 48;
  const dnu = volby.dnu ?? 7;
  const body = j.properties.timeseries
    .map((b) => ({ b, t: new Date(b.time) }))
    .filter((x) => Number.isFinite(x.t.getTime()))
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  // od začátku aktuální hodiny (bod, jehož hodina právě běží, se počítá jako „teď“)
  const od = ted.getTime() - HODINA + 1;
  const budouci = body.filter((x) => x.t.getTime() >= od);

  const hodiny: Hodina[] = [];
  for (const { b, t } of budouci) {
    if (!b.data.next_1_hours) break; // konec hodinových dat
    if (hodiny.length >= hodin) break;
    const sym = normalizujSymbol(b.data.next_1_hours.summary.symbol_code);
    hodiny.push({
      cas: t,
      teplota: cislo(b.data.instant.details.air_temperature),
      srazky: cislo(b.data.next_1_hours.details?.precipitation_amount),
      symbol: sym,
      popis: popisSymbolu(sym),
      vitr: kmh(b.data.instant.details.wind_speed),
      oblacnost: cislo(b.data.instant.details.cloud_area_fraction),
    });
  }
  const prvni = budouci[0];
  const ted1: Hodina | null = hodiny[0]
    ? hodiny[0]
    : prvni
      ? (() => {
          const s = prvni.b.data.next_6_hours?.summary.symbol_code ?? null;
          return {
            cas: prvni.t,
            teplota: cislo(prvni.b.data.instant.details.air_temperature),
            srazky: null,
            symbol: s ? normalizujSymbol(s) : null,
            popis: s ? popisSymbolu(s) : '',
            vitr: kmh(prvni.b.data.instant.details.wind_speed),
            oblacnost: cislo(prvni.b.data.instant.details.cloud_area_fraction),
          };
        })()
      : null;

  // denní souhrny: teploty a vítr ze všech bodů dne, srážky bez dvojího započtení (hodinové, kde jsou, jinak 6h)
  const dny = new Map<
    string,
    {
      cas: Date;
      teploty: number[];
      vitr: number[];
      srazky: number;
      kandidati: { hodina: number; symbol: string }[];
      body: number;
    }
  >();
  let pokrytoDo = 0;
  for (const { b, t } of budouci) {
    const klic = mistniDen(t);
    let d = dny.get(klic);
    if (!d) {
      if (dny.size >= dnu) break;
      d = { cas: t, teploty: [], vitr: [], srazky: 0, kandidati: [], body: 0 };
      dny.set(klic, d);
    }
    d.body++;
    const tep = cislo(b.data.instant.details.air_temperature);
    if (tep !== null) d.teploty.push(tep);
    const v = cislo(b.data.instant.details.wind_speed);
    if (v !== null) d.vitr.push(v);
    const ms = t.getTime();
    if (ms >= pokrytoDo) {
      if (b.data.next_1_hours) {
        d.srazky += cislo(b.data.next_1_hours.details?.precipitation_amount) ?? 0;
        pokrytoDo = ms + HODINA;
      } else if (b.data.next_6_hours) {
        d.srazky += cislo(b.data.next_6_hours.details?.precipitation_amount) ?? 0;
        pokrytoDo = ms + 6 * HODINA;
      }
    }
    // symbol dne: šestihodinový souhrn bodu nejblíž místnímu poledni (pokrývá dopoledne a odpoledne)
    const s6 = b.data.next_6_hours?.summary.symbol_code ?? b.data.next_1_hours?.summary.symbol_code;
    if (s6) d.kandidati.push({ hodina: mistniHodina(t), symbol: s6 });
  }
  const vysledek: Den[] = [];
  for (const [datum, d] of dny) {
    const nejlepsi = [...d.kandidati].sort(
      (a, b) =>
        Math.abs(a.hodina - 11) - Math.abs(b.hodina - 11) ||
        // stejná vzdálenost: dřívější (souhrn přes poledne)
        a.hodina - b.hodina,
    )[0];
    const symbol = nejlepsi ? denniSymbol(nejlepsi.symbol) : 'cloudy';
    vysledek.push({
      datum,
      cas: d.cas,
      max: d.teploty.length ? Math.round(Math.max(...d.teploty)) : null,
      min: d.teploty.length ? Math.round(Math.min(...d.teploty)) : null,
      srazky: Math.round(d.srazky * 10) / 10,
      symbol,
      popis: popisSymbolu(symbol),
      vitrMax: d.vitr.length ? kmh(Math.max(...d.vitr)) : null,
      castecny: mistniDen(d.cas) === mistniDen(ted) && mistniHodina(d.cas) > 1,
    });
  }
  const upd = j.properties.meta?.updated_at ? new Date(j.properties.meta.updated_at) : null;
  const det = (x: (typeof budouci)[number] | undefined, k: string) => cislo(x?.b.data.instant.details[k]);
  const p0 = budouci[0];
  const p3 = p0 ? budouci.find((x) => x.t.getTime() >= p0.t.getTime() + 3 * HODINA) : undefined;
  const tlak = det(p0, 'air_pressure_at_sea_level');
  const tlak3 = det(p3, 'air_pressure_at_sea_level');
  const zmena = tlak !== null && tlak3 !== null ? Math.round((tlak3 - tlak) * 10) / 10 : null;
  const vyska = cislo(j.geometry?.coordinates?.[2]);
  const podminky: Podminky = {
    vyska: vyska === null ? null : Math.round(vyska),
    tlak: tlak === null ? null : Math.round(tlak),
    tlakZmena3h: zmena,
    tlakTrend: trendTlaku(zmena),
    vlhkost: (() => {
      const v = det(p0, 'relative_humidity');
      return v === null ? null : Math.round(v);
    })(),
    smerVetru: smerVetru(det(p0, 'wind_from_direction')),
  };
  return {
    podminky,
    ted: ted1,
    hodiny,
    dny: vysledek,
    modelZ: upd && Number.isFinite(upd.getTime()) ? upd : null,
  };
}
