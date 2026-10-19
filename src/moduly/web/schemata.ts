// Barevná schémata obecního webu. Každé je sada OKLCH barev; z nich se generují CSS proměnné (s hex zálohou pro
// starší prohlížeče). Kontrast všech dvojic, které se na webu skutečně potkávají, ověřuje test
// test/schemata.test.ts (WCAG 2.1 AA 4,5 : 1) — včetně nejhoršího případu: úplně bílá fotka pod tmavým
// gradientem. Nové schéma = přidat položku sem a pustit test.
import {
  BILA,
  kontrastRgb,
  oklchCss,
  oklchNaHex,
  oklchNaSrgb,
  pres,
  type Oklch,
  type Rgb01,
} from '../../lib/oklch.js';

export interface Schema {
  id: string;
  nazev: string;
  popis: string;
  /** tlačítka, odkazy na bílé kartě, rámečky karet (bílý text na ní) */
  primarni: Oklch;
  /** světlá varianta primární — nadpisy a čísla na tmavém skle / přes fotku, nadpisy v patičce */
  naTmave: Oklch;
  /** zvýraznění: pruh pod hlavičkou, tlačítko výzvy (CTA) — tmavý text */
  akcent: Oklch;
  /** aktivní položka menu */
  aktivni: Oklch;
  aktivniText: 'bila' | 'tmava';
  /** téměř černá s nádechem schématu — patička, gradient přes fotku, text na akcentu */
  tmava: Oklch;
  /** velmi světlý odstín — štítky, podklad sekcí */
  svetla: Oklch;
}

export const SCHEMATA: Schema[] = [
  {
    id: 'vlastiborice',
    nazev: 'Zelená obecní',
    popis: 'Tmavá zelená a žlutý pruh — podle dosavadního webu Vlastibořic.',
    primarni: [0.45, 0.12, 145],
    naTmave: [0.88, 0.16, 120],
    akcent: [0.93, 0.17, 106],
    aktivni: [0.8, 0.17, 138],
    aktivniText: 'tmava',
    tmava: [0.22, 0.04, 150],
    svetla: [0.96, 0.03, 140],
  },
  {
    id: 'outdoor',
    nazev: 'Oranžová outdoor',
    popis: 'Výrazná oranžová se svěže zelenou výzvou — sportovní a turistické obce.',
    primarni: [0.55, 0.175, 38],
    naTmave: [0.86, 0.085, 65],
    akcent: [0.88, 0.2, 128],
    aktivni: [0.52, 0.19, 27],
    aktivniText: 'bila',
    tmava: [0.2, 0.03, 55],
    svetla: [0.96, 0.025, 60],
  },
  {
    id: 'uredni-modra',
    nazev: 'Úřední modrá',
    popis: 'Klidná státní modrá se zlatým akcentem — vážný, důvěryhodný dojem.',
    primarni: [0.46, 0.13, 255],
    naTmave: [0.85, 0.08, 240],
    akcent: [0.86, 0.13, 85],
    aktivni: [0.86, 0.13, 85],
    aktivniText: 'tmava',
    tmava: [0.2, 0.04, 255],
    svetla: [0.96, 0.02, 250],
  },
  {
    id: 'vinova',
    nazev: 'Vínová',
    popis: 'Vínově červená a krémová — tradiční, vinařské a historické obce.',
    primarni: [0.44, 0.15, 15],
    naTmave: [0.86, 0.07, 30],
    akcent: [0.88, 0.09, 80],
    aktivni: [0.88, 0.09, 80],
    aktivniText: 'tmava',
    tmava: [0.2, 0.04, 15],
    svetla: [0.96, 0.02, 20],
  },
  {
    id: 'lesni',
    nazev: 'Lesní',
    popis: 'Hluboká jehličnatá zeleň a mechová — obce v lesích a na horách.',
    primarni: [0.4, 0.08, 165],
    naTmave: [0.86, 0.1, 140],
    akcent: [0.82, 0.14, 128],
    aktivni: [0.82, 0.14, 128],
    aktivniText: 'tmava',
    tmava: [0.19, 0.03, 165],
    svetla: [0.96, 0.02, 160],
  },
  {
    id: 'bridlice',
    nazev: 'Břidlicová',
    popis: 'Střídmá šedomodrá s oranžovou výzvou — moderní a nenápadné.',
    primarni: [0.45, 0.04, 250],
    naTmave: [0.86, 0.03, 250],
    akcent: [0.8, 0.13, 62],
    aktivni: [0.8, 0.13, 62],
    aktivniText: 'tmava',
    tmava: [0.2, 0.015, 250],
    svetla: [0.96, 0.008, 250],
  },
  {
    id: 'terakota',
    nazev: 'Terakota',
    popis: 'Teplá cihlová a pískové tóny — venkovské a jihočeské obce.',
    primarni: [0.5, 0.13, 40],
    naTmave: [0.86, 0.085, 65],
    akcent: [0.88, 0.1, 85],
    aktivni: [0.88, 0.1, 85],
    aktivniText: 'tmava',
    tmava: [0.21, 0.03, 45],
    svetla: [0.96, 0.02, 60],
  },
  {
    id: 'svestkova',
    nazev: 'Švestková',
    popis: 'Fialová a medová — neobvyklé, ale stále klidné.',
    primarni: [0.44, 0.13, 320],
    naTmave: [0.86, 0.07, 320],
    akcent: [0.87, 0.12, 90],
    aktivni: [0.87, 0.12, 90],
    aktivniText: 'tmava',
    tmava: [0.2, 0.04, 320],
    svetla: [0.96, 0.02, 320],
  },
  {
    id: 'morska',
    nazev: 'Mořská',
    popis: 'Petrolejová a tyrkysová — vodní nádrže, rybníky, lázně.',
    primarni: [0.45, 0.075, 215],
    naTmave: [0.86, 0.08, 195],
    akcent: [0.84, 0.12, 180],
    aktivni: [0.84, 0.12, 180],
    aktivniText: 'tmava',
    tmava: [0.2, 0.03, 215],
    svetla: [0.96, 0.02, 200],
  },
];

/** průhlednosti přes fotku: gradient shora/dole, sklo panelů */
export const GRADIENT_HORE = 0.72;
export const GRADIENT_DOLE = 0.9;
export const SKLO = 0.45;

export function schemaPodleId(id: string | null | undefined): Schema | undefined {
  return SCHEMATA.find((s) => s.id === id);
}

/** nejhorší podklad pod textem přes fotku: úplně bílá fotka pod gradientem v nejsvětlejším místě */
export function nejhorsiPodklad(s: Schema): Rgb01 {
  return pres(oklchNaSrgb(s.tmava), GRADIENT_HORE, BILA);
}

/** dvojice barev, které se na webu potkávají, s požadovaným kontrastem */
export function kontrolniDvojice(s: Schema): { nazev: string; popredi: Rgb01; pozadi: Rgb01; min: number }[] {
  const c = oklchNaSrgb;
  const hero = nejhorsiPodklad(s);
  const sklo = pres(c(s.tmava), SKLO, hero);
  const tmava = c(s.tmava);
  return [
    { nazev: 'bílý text na primární (tlačítka, menu)', popredi: BILA, pozadi: c(s.primarni), min: 4.5 },
    { nazev: 'odkaz (primární) na bílé kartě', popredi: c(s.primarni), pozadi: BILA, min: 4.5 },
    { nazev: 'tmavý text na světlém podkladu', popredi: tmava, pozadi: c(s.svetla), min: 4.5 },
    { nazev: 'primární na světlém podkladu', popredi: c(s.primarni), pozadi: c(s.svetla), min: 4.5 },
    { nazev: 'tmavý text na akcentu (CTA, pruh)', popredi: tmava, pozadi: c(s.akcent), min: 4.5 },
    {
      nazev: 'text aktivní položky menu',
      popredi: s.aktivniText === 'bila' ? BILA : tmava,
      pozadi: c(s.aktivni),
      min: 4.5,
    },
    { nazev: 'bílý text přes fotku (nejhorší případ)', popredi: BILA, pozadi: hero, min: 4.5 },
    { nazev: 'světlá primární přes fotku (nejhorší případ)', popredi: c(s.naTmave), pozadi: hero, min: 4.5 },
    { nazev: 'světlá primární na skle', popredi: c(s.naTmave), pozadi: sklo, min: 4.5 },
    { nazev: 'světlá primární v patičce', popredi: c(s.naTmave), pozadi: tmava, min: 4.5 },
    { nazev: 'šedý text v patičce', popredi: c([0.88, 0, 0]), pozadi: tmava, min: 4.5 },
  ];
}

export function overSchema(s: Schema) {
  return kontrolniDvojice(s).map((d) => ({ ...d, kontrast: kontrastRgb(d.popredi, d.pozadi) }));
}

/** CSS proměnné schématu: hex záloha + OKLCH v @supports (moderní prohlížeče) */
export function cssSchematu(s: Schema, selektor = ':root'): string {
  const tmavaText = s.tmava;
  const hex = {
    '--primarni': oklchNaHex(s.primarni),
    '--na-tmave': oklchNaHex(s.naTmave),
    '--akcent': oklchNaHex(s.akcent),
    '--aktivni': oklchNaHex(s.aktivni),
    '--aktivni-text': s.aktivniText === 'bila' ? '#ffffff' : oklchNaHex(tmavaText),
    '--tmava': oklchNaHex(s.tmava),
    '--svetla': oklchNaHex(s.svetla),
  };
  const rgba = (o: Oklch, a: number) => {
    const [r, g, b] = oklchNaSrgb(o).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };
  const zaklad = Object.entries(hex)
    .map(([k, v]) => `${k}:${v}`)
    .concat([
      `--gradient-hore:${rgba(s.tmava, GRADIENT_HORE)}`,
      `--gradient-dole:${rgba(s.tmava, GRADIENT_DOLE)}`,
      `--sklo:${rgba(s.tmava, SKLO)}`,
      `--sklo-husty:${rgba(s.tmava, 0.82)}`,
      `--primarni-pruhledna:${rgba(s.primarni, 0.45)}`,
      // původní proměnné stylu (správa, formuláře) navázané na schéma
      `--zelena:${hex['--primarni']}`,
      `--zelena-tmava:${oklchNaHex([Math.max(0.2, s.primarni[0] - 0.1), s.primarni[1], s.primarni[2]])}`,
      `--zelena-svetla:${hex['--svetla']}`,
    ])
    .join(';');
  const moderni = [
    `--primarni:${oklchCss(s.primarni)}`,
    `--na-tmave:${oklchCss(s.naTmave)}`,
    `--akcent:${oklchCss(s.akcent)}`,
    `--aktivni:${oklchCss(s.aktivni)}`,
    `--tmava:${oklchCss(s.tmava)}`,
    `--svetla:${oklchCss(s.svetla)}`,
    `--primarni-pruhledna:color-mix(in oklch, var(--primarni) 45%, transparent)`,
  ].join(';');
  return `${selektor}{${zaklad}}@supports (color: oklch(0 0 0)){${selektor}{${moderni}}}`;
}
