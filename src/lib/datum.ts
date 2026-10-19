// Data v českém čase (Europe/Prague) bez knihovny: úřední deska počítá dny vyvěšení podle kalendáře, ne po 24 h.
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** datum v Praze jako 'YYYY-MM-DD' */
export function datumPraha(d: Date): string {
  return FMT.format(d);
}

function posunPraha(utc: Date): number {
  // o kolik minut je Praha napřed před UTC v daném okamžiku
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Prague',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(utc);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const jako = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  const utcBezMs = Math.floor(utc.getTime() / 1000) * 1000;
  return Math.round((jako - utcBezMs) / 60_000);
}

/** 'YYYY-MM-DD' + čas v Praze → Date (UTC) */
export function casPraha(datum: string, hodina = 0, minuta = 0, sekunda = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datum);
  if (!m) return null;
  const odhad = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hodina, minuta, sekunda);
  if (Number.isNaN(odhad)) return null;
  const posun = posunPraha(new Date(odhad));
  const vysledek = new Date(odhad - posun * 60_000);
  // přechod letního času: druhý odhad
  const posun2 = posunPraha(vysledek);
  return posun2 === posun ? vysledek : new Date(odhad - posun2 * 60_000);
}

export const zacatekDne = (datum: string) => casPraha(datum, 0, 0, 0);
export const konecDne = (datum: string) => casPraha(datum, 23, 59, 59);

/** počet kalendářních dní mezi dvěma daty 'YYYY-MM-DD' */
export function rozdilDni(od: string, do_: string): number {
  return Math.round((Date.parse(do_ + 'T00:00:00Z') - Date.parse(od + 'T00:00:00Z')) / 86_400_000);
}

export function pridejDny(datum: string, dni: number): string {
  const d = new Date(Date.parse(datum + 'T12:00:00Z') + dni * 86_400_000);
  return d.toISOString().slice(0, 10);
}
