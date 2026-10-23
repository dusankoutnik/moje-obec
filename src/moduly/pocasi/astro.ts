// Východ a západ Slunce a Měsíce a fáze Měsíce — počítá se lokálně (suncalc, přesnost ~ minuty), žádný dotaz ven.
// Časy pro dnešní den v Praze; Měsíc někdy v daný den nevyjde nebo nezapadne (pak null).
import SunCalc from 'suncalc';
import { mistniDen } from './met.js';

export const FAZE = [
  'moon-new',
  'moon-waxing-crescent',
  'moon-first-quarter',
  'moon-waxing-gibbous',
  'moon-full',
  'moon-waning-gibbous',
  'moon-last-quarter',
  'moon-waning-crescent',
] as const;
export type Faze = (typeof FAZE)[number];

export interface Astro {
  slunceVychod: Date | null;
  slunceZapad: Date | null;
  mesicVychod: Date | null;
  mesicZapad: Date | null;
  faze: Faze;
  /** osvětlená část Měsíce v procentech */
  osvetleni: number;
}

const platne = (d: Date | undefined) => (d && Number.isFinite(d.getTime()) ? d : null);

/** fáze 0…1 (0 nov, 0,25 první čtvrť, 0,5 úplněk, 0,75 poslední čtvrť) → jedna z 8 ikon */
export const fazeZCisla = (f: number): Faze => FAZE[Math.round(f * 8) % 8]!;

export function astro(ted: Date, lat: number, lon: number): Astro {
  const den = mistniDen(ted);
  // Slunce: poledne UTC daného dne leží v Praze vždy ve stejném dni
  const slunce = SunCalc.getTimes(new Date(`${den}T12:00:00Z`), lat, lon);
  // Měsíc: suncalc hledá v UTC dni → projít den před i daný den a vzít události, které padnou na dnešek v Praze
  const vychody: Date[] = [];
  const zapady: Date[] = [];
  for (const posun of [-1, 0, 1]) {
    const d = new Date(`${den}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + posun);
    const m = SunCalc.getMoonTimes(d, lat, lon, true);
    const v = platne(m.rise);
    const z = platne(m.set);
    if (v && mistniDen(v) === den) vychody.push(v);
    if (z && mistniDen(z) === den) zapady.push(z);
  }
  const prvni = (a: Date[]) => a.sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
  const osv = SunCalc.getMoonIllumination(ted);
  return {
    slunceVychod: platne(slunce.sunrise),
    slunceZapad: platne(slunce.sunset),
    mesicVychod: prvni(vychody),
    mesicZapad: prvni(zapady),
    faze: fazeZCisla(osv.phase),
    osvetleni: Math.round(osv.fraction * 100),
  };
}
