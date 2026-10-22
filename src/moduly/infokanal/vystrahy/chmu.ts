// Výstrahy ČHMÚ — open data CAP 1.2 (https://opendata.chmi.cz/meteorology/weather/alerts/cap/).
// Soubory alert_cap_50_DDHHMM.xml = SIVS (počasí i povodně); nejnovější podle data ve výpisu adresáře.
// Bloky <info> jsou česky i anglicky; „Žádná výstraha…“ a „Výhled jevů“ se přeskakují. Stupeň je v parametru
// awareness_level („2; yellow; Moderate“), území v geocode CISORP (kód ORP).

export const CHMU_ADRESAR = 'https://opendata.chmi.cz/meteorology/weather/alerts/cap/';
export const CHMU_WEB = 'https://vystrahy-cr.chmi.cz/';

export type StupenChmu = 'yellow' | 'orange' | 'red';
export const STUPNE: Record<number, StupenChmu> = { 2: 'yellow', 3: 'orange', 4: 'red' };
export const STUPEN_CS: Record<StupenChmu, string> = { yellow: 'žlutá', orange: 'oranžová', red: 'červená' };
export const STUPEN_AKUZATIV: Record<StupenChmu, string> = {
  yellow: 'žlutou',
  orange: 'oranžovou',
  red: 'ČERVENOU',
};
export const PORADI: Record<StupenChmu, number> = { yellow: 2, orange: 3, red: 4 };

export interface VystrahaChmu {
  jev: string;
  stupen: StupenChmu;
  od: Date | null;
  do: Date | null;
  nadpis: string;
  popis: string;
  pokyny: string;
}

export function dekoduj(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function znacka(xml: string, t: string): string {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(xml);
  return m ? dekoduj(m[1]) : '';
}

function datum(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** CAP → výstrahy pro dané ORP, které ještě neskončily (jen česky, jen skutečné výstrahy) */
export function parsujCap(xml: string, orp: string, ted: Date): VystrahaChmu[] {
  if (znacka(xml, 'status') !== 'Actual') return [];
  const vysledek: VystrahaChmu[] = [];
  for (const [, info] of xml.matchAll(/<info>([\s\S]*?)<\/info>/g)) {
    if (!info || znacka(info, 'language') !== 'cs') continue;
    const jev = znacka(info, 'event');
    if (!jev || /^Žádn|výhled/i.test(jev)) continue;
    const parametry = Object.fromEntries(
      [
        ...info.matchAll(
          /<parameter>\s*<valueName>([^<]*)<\/valueName>\s*<value>([\s\S]*?)<\/value>\s*<\/parameter>/g,
        ),
      ].map((m) => [m[1]!.trim(), dekoduj(m[2])]),
    );
    const stupen = STUPNE[parseInt(parametry.awareness_level ?? '', 10)];
    if (!stupen) continue;
    const orpy = [...info.matchAll(/<valueName>CISORP<\/valueName>\s*<value>(\d+)<\/value>/g)].map(
      (m) => m[1],
    );
    if (!orpy.includes(orp)) continue;
    const do_ = datum(parametry.eventEndingTime || znacka(info, 'expires'));
    if (do_ && do_ < ted) continue; // už skončila
    vysledek.push({
      jev,
      stupen,
      od: datum(znacka(info, 'onset') || znacka(info, 'effective')),
      do: do_,
      nadpis: znacka(info, 'headline'),
      popis: znacka(info, 'description'),
      pokyny: znacka(info, 'instruction'),
    });
  }
  // stejný jev a stupeň víckrát (různé bloky) → jeden, s nejpozdějším koncem
  const podleKlice = new Map<string, VystrahaChmu>();
  for (const v of vysledek) {
    const k = `${v.jev}|${v.stupen}`;
    const byla = podleKlice.get(k);
    if (!byla || (v.do && (!byla.do || v.do > byla.do))) podleKlice.set(k, v);
  }
  return [...podleKlice.values()];
}

const MESICE: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** nejnovější soubor SIVS (alert_cap_50_*) z výpisu adresáře (nginx autoindex, čas v UTC) */
export function nejnovejsiSoubor(html: string): { nazev: string; razitko: string } | null {
  let nej: { nazev: string; t: number; razitko: string } | null = null;
  for (const m of html.matchAll(/(alert_cap_50_\d+\.xml)<\/a>\s+(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2})/g)) {
    const mesic = MESICE[m[3]!];
    if (mesic === undefined) continue;
    const t = Date.UTC(Number(m[4]), mesic, Number(m[2]), Number(m[5]), Number(m[6]));
    if (!nej || t > nej.t)
      nej = { nazev: m[1]!, t, razitko: `${m[1]} ${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}` };
  }
  return nej ? { nazev: nej.nazev, razitko: nej.razitko } : null;
}
