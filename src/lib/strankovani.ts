// Stránkování seznamů: odkazy na první/poslední, okolní čísla stran s výpustkou a volba počtu na stránce.

export interface Strankovani {
  strana: number;
  stran: number;
  celkem: number;
  na: number;
  moznosti: number[];
  /** cesta formuláře „Na stránce“ a skrytá pole, která se mají zachovat (filtr) */
  cesta: string;
  skryte: Record<string, string>;
  prvni: string | null;
  predchozi: string | null;
  dalsi: string | null;
  posledni: string | null;
  /** čísla stran; null = výpustka */
  polozky: ({ strana: number; href: string; aktualni: boolean } | null)[];
}

/** strany kolem aktuální (±2), vždy první a poslední; mezery delší než jedna strana nahradí výpustka */
export function cislaStran(strana: number, stran: number, okoli = 2): (number | null)[] {
  const vybrane = new Set([1, stran]);
  for (let i = strana - okoli; i <= strana + okoli; i++) if (i >= 1 && i <= stran) vybrane.add(i);
  const serazene = [...vybrane].sort((a, b) => a - b);
  const vysledek: (number | null)[] = [];
  serazene.forEach((n, i) => {
    const pred = serazene[i - 1];
    if (pred !== undefined && n - pred === 2) vysledek.push(pred + 1);
    else if (pred !== undefined && n - pred > 2) vysledek.push(null);
    vysledek.push(n);
  });
  return vysledek;
}

export function strankovani(v: {
  cesta: string;
  parametry: Record<string, string>;
  strana: number;
  stran: number;
  celkem: number;
  na: number;
  moznosti: number[];
}): Strankovani {
  const stran = Math.max(1, v.stran);
  const strana = Math.min(Math.max(1, v.strana), stran);
  const vychoziNa = v.moznosti[0];
  const href = (n: number) => {
    const q = new URLSearchParams(v.parametry);
    if (v.na !== vychoziNa) q.set('na', String(v.na));
    if (n > 1) q.set('strana', String(n));
    const s = q.toString();
    return s ? `${v.cesta}?${s}` : v.cesta;
  };
  return {
    strana,
    stran,
    celkem: v.celkem,
    na: v.na,
    moznosti: v.moznosti,
    cesta: v.cesta,
    skryte: v.parametry,
    prvni: strana > 1 ? href(1) : null,
    predchozi: strana > 1 ? href(strana - 1) : null,
    dalsi: strana < stran ? href(strana + 1) : null,
    posledni: strana < stran ? href(stran) : null,
    polozky: cislaStran(strana, stran).map((n) =>
      n === null ? null : { strana: n, href: href(n), aktualni: n === strana },
    ),
  };
}
