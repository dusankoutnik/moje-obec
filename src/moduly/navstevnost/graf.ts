// Sloupcový graf návštěvníků po dnech jako inline SVG (bez knihovny a CDN): jedna řada = bez legendy, sloupce
// nejvýš 24 jednotek široké se zakulaceným vrškem 4, popisek hodnoty jen u maxima, recesivní osa. Najetí myší
// (i bez JavaScriptu) ukáže <title> nad celou výškou dne; textová alternativa je tabulka pod grafem.

export interface DenGrafu {
  den: string;
  navstevnici: number;
}

export interface Graf {
  W: number;
  H: number;
  dole: number;
  vlevo: number;
  vpravo: number;
  sloupce: { d: string; hitX: number; hitW: number; popis: string }[];
  maximum: { x: number; y: number; text: string } | null;
  osa: { x: number; text: string; kotva: 'start' | 'middle' | 'end' }[];
}

const W = 760;
const H = 220;
const NAHORE = 26; // místo na popisek maxima
const DOLE = H - 28; // základní linka (pod ní data na ose)
const OKRAJ = 8;

/** d. m. z YYYY-MM-DD */
export function kratkeDatum(den: string): string {
  const [, m, d] = den.split('-');
  return `${Number(d)}. ${Number(m)}.`;
}

/** obdélník se zakulacenými horními rohy (dolní hrana sedí na základní lince) */
function sloupec(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  const f = (n: number) => Math.round(n * 10) / 10;
  return (
    `M${f(x)} ${f(y + h)}V${f(y + rr)}Q${f(x)} ${f(y)} ${f(x + rr)} ${f(y)}` +
    `H${f(x + w - rr)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + rr)}V${f(y + h)}Z`
  );
}

export function grafNavstevniku(serie: DenGrafu[], popis: (d: DenGrafu) => string): Graf {
  const n = Math.max(serie.length, 1);
  const slot = (W - 2 * OKRAJ) / n;
  const sirka = Math.max(2, Math.min(24, slot - 2)); // aspoň 2 jednotky mezera mezi sloupci
  const max = Math.max(0, ...serie.map((d) => d.navstevnici));
  const vyska = DOLE - NAHORE;
  let iMax = -1;
  serie.forEach((d, i) => {
    if (max > 0 && d.navstevnici === max && iMax < 0) iMax = i;
  });
  const sloupce = serie.map((d, i) => {
    const h = max ? (d.navstevnici / max) * vyska : 0;
    const x = OKRAJ + i * slot + (slot - sirka) / 2;
    return {
      d: h > 0 ? sloupec(x, DOLE - h, sirka, Math.max(h, 1), 4) : '',
      hitX: Math.round((OKRAJ + i * slot) * 10) / 10,
      hitW: Math.round(slot * 10) / 10,
      popis: popis(d),
    };
  });
  const maxX = OKRAJ + iMax * slot + slot / 2;
  const maximum =
    iMax >= 0
      ? {
          x: Math.round(Math.min(Math.max(maxX, 20), W - 20)),
          y: Math.round(DOLE - vyska - 8),
          text: String(max),
        }
      : null;
  // data na ose: první, poslední a dvě mezi nimi (u týdne každý den)
  const indexy =
    n <= 7 ? serie.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const osa = [...new Set(indexy)].map((i) => ({
    x: Math.round(OKRAJ + i * slot + slot / 2),
    text: kratkeDatum(serie[i]?.den ?? ''),
    kotva: (n > 7 && i === 0 ? 'start' : n > 7 && i === n - 1 ? 'end' : 'middle') as
      'start' | 'middle' | 'end',
  }));
  for (const o of osa) {
    if (o.kotva === 'start') o.x = OKRAJ;
    if (o.kotva === 'end') o.x = W - OKRAJ;
  }
  return { W, H, dole: DOLE, vlevo: OKRAJ, vpravo: W - OKRAJ, sloupce, maximum, osa };
}
