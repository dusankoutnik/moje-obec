// Písma obecního webu — dvojice tělo + nadpisy (+ volitelně ozdobné písmo velkého titulku). Všechna self-hosted
// z balíčků @fontsource (npm), jen podmnožiny latin + latin-ext (plná čeština — ověřeno na glyfech, viz
// docs/ARCHITEKTURA.md ADR 21). Licence: SIL OFL 1.1, Ubuntu Font Licence 1.0 (docs/LICENCE-TRETICH-STRAN.md).
export interface Rez {
  rodina: string;
  balik: string;
  vahy: number[];
}

export interface Pismo {
  id: string;
  nazev: string;
  popis: string;
  telo: Rez;
  nadpis: Rez;
  /** ozdobné písmo jen pro velký název obce v úvodu */
  display?: Rez;
  /** úzká písma (Genos) působí menší — zvětšení základní velikosti */
  meritko: number;
  /** u vlastní kombinace: id rodin z katalogu RODINY */
  slozeni?: { telo: string; nadpis: string; titulek: string };
}

const r = (rodina: string, balik: string, vahy: number[]): Rez => ({ rodina, balik, vahy });

export const PISMA: Pismo[] = [
  {
    id: 'ubuntu',
    nazev: 'Ubuntu',
    popis: 'Přátelské a dobře čitelné humanistické písmo.',
    telo: r('Ubuntu', 'ubuntu', [400, 700]),
    nadpis: r('Ubuntu', 'ubuntu', [500, 700]),
    meritko: 1,
  },
  {
    id: 'citelne',
    nazev: 'Atkinson Hyperlegible',
    popis: 'Navržené pro slabozraké — maximální čitelnost (rozlišuje I, l, 1).',
    telo: r('Atkinson Hyperlegible', 'atkinson-hyperlegible', [400, 700]),
    nadpis: r('Atkinson Hyperlegible', 'atkinson-hyperlegible', [700]),
    meritko: 1,
  },
  {
    id: 'moderni',
    nazev: 'Inter + Rubik',
    popis: 'Moderní a neutrální; nadpisy s měkce zakulaceným Rubikem.',
    telo: r('Inter', 'inter', [400, 600, 700]),
    nadpis: r('Rubik', 'rubik', [500, 700]),
    meritko: 1,
  },
  {
    id: 'source',
    nazev: 'Source Sans 3',
    popis: 'Střídmé úřední písmo, dobře se čte i v dlouhých textech.',
    telo: r('Source Sans 3', 'source-sans-3', [400, 600, 700]),
    nadpis: r('Source Sans 3', 'source-sans-3', [700]),
    meritko: 1.04,
  },
  {
    id: 'tradicni',
    nazev: 'Tradiční (Merriweather)',
    popis: 'Patkové nadpisy jako z kroniky, tělo bezpatkové — vážný, tradiční dojem.',
    telo: r('Source Sans 3', 'source-sans-3', [400, 600, 700]),
    nadpis: r('Merriweather', 'merriweather', [700]),
    meritko: 1.04,
  },
  {
    id: 'nunito',
    nazev: 'Nunito',
    popis: 'Zakulacené a vlídné — školky, spolky, menší obce.',
    telo: r('Nunito', 'nunito', [400, 700]),
    nadpis: r('Nunito', 'nunito', [800]),
    meritko: 1,
  },
  {
    id: 'genos',
    nazev: 'Genos',
    popis: 'Geometrické, technické — jako na pvlh24.cz (větší základní velikost).',
    telo: r('Genos', 'genos', [400, 600, 700]),
    nadpis: r('Genos', 'genos', [700]),
    meritko: 1.2,
  },
  {
    id: 'outdoor',
    nazev: 'Genos + Rubik Dirt',
    popis: 'Genos a „ušpiněný“ ozdobný titulek — sportovní a turistický styl.',
    telo: r('Genos', 'genos', [400, 600, 700]),
    nadpis: r('Genos', 'genos', [700]),
    display: r('Rubik Dirt', 'rubik-dirt', [400]),
    meritko: 1.2,
  },
];

/** Jednotlivá písma pro vlastní kombinaci (tělo × nadpisy × velký titulek). Ozdobná písma jen pro titulek. */
export interface Rodina {
  id: string;
  nazev: string;
  popis: string;
  telo?: Rez;
  nadpis?: Rez;
  titulek: Rez;
  /** úzká písma působí menší — zvětšení základní velikosti, když jsou písmem textu */
  meritko: number;
}

export const RODINY: Rodina[] = [
  {
    id: 'ubuntu',
    nazev: 'Ubuntu',
    popis: 'přátelské, humanistické',
    telo: r('Ubuntu', 'ubuntu', [400, 500, 700]),
    nadpis: r('Ubuntu', 'ubuntu', [700]),
    titulek: r('Ubuntu', 'ubuntu', [700]),
    meritko: 1,
  },
  {
    id: 'atkinson',
    nazev: 'Atkinson Hyperlegible',
    popis: 'nejlepší čitelnost',
    telo: r('Atkinson Hyperlegible', 'atkinson-hyperlegible', [400, 700]),
    nadpis: r('Atkinson Hyperlegible', 'atkinson-hyperlegible', [700]),
    titulek: r('Atkinson Hyperlegible', 'atkinson-hyperlegible', [700]),
    meritko: 1,
  },
  {
    id: 'inter',
    nazev: 'Inter',
    popis: 'moderní, neutrální',
    telo: r('Inter', 'inter', [400, 600, 700]),
    nadpis: r('Inter', 'inter', [700]),
    titulek: r('Inter', 'inter', [800]),
    meritko: 1,
  },
  {
    id: 'rubik',
    nazev: 'Rubik',
    popis: 'měkce zakulacené',
    telo: r('Rubik', 'rubik', [400, 600, 700]),
    nadpis: r('Rubik', 'rubik', [700]),
    titulek: r('Rubik', 'rubik', [800]),
    meritko: 1,
  },
  {
    id: 'source',
    nazev: 'Source Sans 3',
    popis: 'střídmé, úřední',
    telo: r('Source Sans 3', 'source-sans-3', [400, 600, 700]),
    nadpis: r('Source Sans 3', 'source-sans-3', [700]),
    titulek: r('Source Sans 3', 'source-sans-3', [800]),
    meritko: 1.04,
  },
  {
    id: 'merriweather',
    nazev: 'Merriweather',
    popis: 'patkové, tradiční',
    telo: r('Merriweather', 'merriweather', [400, 700]),
    nadpis: r('Merriweather', 'merriweather', [700]),
    titulek: r('Merriweather', 'merriweather', [800]),
    meritko: 0.96,
  },
  {
    id: 'nunito',
    nazev: 'Nunito',
    popis: 'zakulacené, vlídné',
    telo: r('Nunito', 'nunito', [400, 600, 700]),
    nadpis: r('Nunito', 'nunito', [800]),
    titulek: r('Nunito', 'nunito', [800]),
    meritko: 1,
  },
  {
    id: 'genos',
    nazev: 'Genos',
    popis: 'geometrické, technické (jako pvlh24.cz)',
    telo: r('Genos', 'genos', [400, 600, 700]),
    nadpis: r('Genos', 'genos', [700]),
    titulek: r('Genos', 'genos', [700]),
    meritko: 1.2,
  },
  {
    id: 'rubik-dirt',
    nazev: 'Rubik Dirt',
    popis: 'ošoupané, ozdobné — jen velký titulek',
    titulek: r('Rubik Dirt', 'rubik-dirt', [400]),
    meritko: 1,
  },
];

export const rodinaPodleId = (id: unknown) => RODINY.find((x) => x.id === id);
export const proTelo = RODINY.filter((x) => x.telo);
export const proNadpis = RODINY.filter((x) => x.nadpis);

/** vlastní kombinace z katalogu; neplatné id → null */
export function slozPismo(teloId: unknown, nadpisId: unknown, titulekId: unknown): Pismo | null {
  const t = rodinaPodleId(teloId);
  const n = rodinaPodleId(nadpisId);
  const ti = rodinaPodleId(titulekId) ?? n;
  if (!t?.telo || !n?.nadpis || !ti) return null;
  return {
    id: 'vlastni',
    nazev: [t.nazev, n.nazev, ti.nazev].filter((x, i, a) => a.indexOf(x) === i).join(' + '),
    popis: 'Vlastní kombinace',
    telo: t.telo,
    nadpis: n.nadpis,
    display: ti.titulek,
    meritko: t.meritko,
    slozeni: { telo: t.id, nadpis: n.id, titulek: ti.id },
  };
}

/** u hotové dvojice: id rodin, aby šla ve správě předvyplnit vlastní kombinace */
export function slozeniSady(p: Pismo): { telo: string; nadpis: string; titulek: string } {
  if (p.slozeni) return p.slozeni;
  const id = (rez?: Rez) =>
    RODINY.find((x) => x.titulek.balik === rez?.balik || x.telo?.balik === rez?.balik)?.id ?? 'ubuntu';
  return { telo: id(p.telo), nadpis: id(p.nadpis), titulek: id(p.display ?? p.nadpis) };
}

export const VELIKOSTI = { normalni: 1, velke: 1.25, extra: 1.375 } as const;
export type Velikost = keyof typeof VELIKOSTI;
export const jeVelikost = (v: unknown): v is Velikost => typeof v === 'string' && v in VELIKOSTI;

export function pismoPodleId(id: string | null | undefined): Pismo {
  return PISMA.find((p) => p.id === id) ?? PISMA[0]!;
}

const ZALOHA = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const zasobnik = (rez: Rez) =>
  `'${rez.rodina}', ${rez.rodina === 'Merriweather' ? 'Georgia, serif' : ZALOHA}`;

/** @font-face pro dané dvojice (prohlížeč stahuje jen písma, která stránka opravdu použije) */
export function fontFace(pisma: Pismo[]): string {
  return fontFaceRezu(pisma.flatMap((p) => [p.telo, p.nadpis, p.display].filter((x): x is Rez => !!x)));
}

/** zásobník písma (CSS font-family) pro jeden řez */
export const rodinaRezu = (rez: Rez) => zasobnik(rez);

/** @font-face pro jednotlivé řezy */
export function fontFaceRezu(rezy: Rez[]): string {
  const videno = new Set<string>();
  const out: string[] = [];
  for (const rez of rezy)
    for (const v of rez.vahy) {
      const klic = `${rez.balik}-${v}`;
      if (videno.has(klic)) continue;
      videno.add(klic);
      for (const [podmnozina, rozsah] of [
        [
          'latin',
          'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
        ],
        [
          'latin-ext',
          'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
        ],
      ] as const)
        out.push(
          `@font-face{font-family:'${rez.rodina}';font-style:normal;font-display:swap;font-weight:${v};src:url(/static/fonty/${rez.balik}/files/${rez.balik}-${podmnozina}-${v}-normal.woff2) format('woff2');unicode-range:${rozsah}}`,
        );
    }
  return out.join('');
}

/** CSS proměnné písma pro :root */
export function cssPisma(p: Pismo): string {
  return `:root{--pismo:${zasobnik(p.telo)};--pismo-nadpis:${zasobnik(p.nadpis)};--pismo-display:${zasobnik(p.display ?? p.nadpis)};--vaha-nadpis:${Math.max(...p.nadpis.vahy)};--meritko:${p.meritko}}`;
}

export function rodinaCss(p: Pismo, cast: 'telo' | 'nadpis' | 'display' = 'telo'): string {
  return zasobnik(cast === 'display' ? (p.display ?? p.nadpis) : p[cast]);
}
