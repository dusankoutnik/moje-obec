// Časy výstrah — vše v pražském čase (zdroje posílají UTC nebo pražský čas bez pásma), bez knihovny.
import { casPraha, datumPraha, pridejDny } from '../../../lib/datum.js';

const DNY = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];

/** části data v Praze: den v týdnu (zkratka), „6. 11.“, „9:00“, „YYYY-MM-DD“, hodina */
export function castiPraha(d: Date) {
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
    datum: `${Number(g('day'))}. ${Number(g('month'))}.`,
    cas: `${Number(g('hour'))}:${g('minute')}`,
    ymd: datumPraha(d),
    hodina: Number(g('hour')),
  };
}

/** „pá 6. 11. 9:00“ */
export function kdy(d: Date): string {
  const p = castiPraha(d);
  return `${p.den} ${p.datum} ${p.cas}`;
}

/** „pá 6. 11. 9:00–15:30“, přes půlnoc „pá 6. 11. 22:00 – so 7. 11. 4:00“, bez konce „od … do odvolání“ */
export function rozsah(od: Date | null, do_: Date | null): string {
  if (!od) return do_ ? `do ${kdy(do_)}` : '';
  if (!do_) return `od ${kdy(od)} do odvolání`;
  const a = castiPraha(od);
  const b = castiPraha(do_);
  return a.ymd === b.ymd ? `${a.den} ${a.datum} ${a.cas}–${b.cas}` : `${kdy(od)} – ${kdy(do_)}`;
}

/** noční klid 22–6 h: kdy rozeslat zprávu zjištěnou v noci (6:30 nejbližšího rána), přes den null */
export function konecNocnihoKlidu(ted: Date): Date | null {
  const p = castiPraha(ted);
  if (p.hodina >= 6 && p.hodina < 22) return null;
  const den = p.hodina >= 22 ? pridejDny(p.ymd, 1) : p.ymd;
  return casPraha(den, 6, 30);
}

/** zítřejší datum v Praze (YYYY-MM-DD) */
export function zitra(ted: Date): string {
  return pridejDny(datumPraha(ted), 1);
}

/** „6.10.2026 08:00“ (pražský čas, jak ho píše SčVK) → Date; správně i přes letní/zimní čas */
export function prazskyCas(s: string | null | undefined): Date | null {
  const m = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s ?? '');
  if (!m) return null;
  const ymd = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return casPraha(ymd, Number(m[4] ?? 0), Number(m[5] ?? 0));
}
