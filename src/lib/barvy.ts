// Barvy obce s hlídáním kontrastu (WCAG 2.1: běžný text 4,5:1). Z jedné primární barvy se odvodí paleta;
// když je barva moc světlá na bílý text / odkazy na bílém pozadí, automaticky se ztmaví, dokud kontrast nevyhoví.
type Rgb = [number, number, number];

export function hexNaRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbNaHex([r, g, b]: Rgb): string {
  return (
    '#' +
    [r, g, b]
      .map((x) =>
        Math.round(Math.max(0, Math.min(255, x)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function jas([r, g, b]: Rgb): number {
  const k = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * k(r) + 0.7152 * k(g) + 0.0722 * k(b);
}

export function kontrast(a: string, b: string): number {
  const x = hexNaRgb(a);
  const y = hexNaRgb(b);
  if (!x || !y) return 1;
  const [l1, l2] = [jas(x), jas(y)].sort((p, q) => q - p);
  return (l1! + 0.05) / (l2! + 0.05);
}

export function smichej(a: string, b: string, podilB: number): string {
  const x = hexNaRgb(a)!;
  const y = hexNaRgb(b)!;
  return rgbNaHex([0, 1, 2].map((i) => x[i]! * (1 - podilB) + y[i]! * podilB) as Rgb);
}

export interface Paleta {
  primarni: string;
  tmava: string;
  svetla: string;
  upravena: boolean;
  kontrast: number;
}

/** paleta z barvy obce; primární barva má vždy kontrast ≥ 4,5 vůči bílé (text na tlačítkách, odkazy na bílém) */
export function paleta(barva: string, minKontrast = 4.5): Paleta {
  const zaklad = hexNaRgb(barva) ? barva.toLowerCase() : '#1b5e20';
  let p = zaklad;
  for (let i = 0; i < 40 && kontrast(p, '#ffffff') < minKontrast; i++) p = smichej(p, '#000000', 0.06);
  return {
    primarni: p,
    tmava: smichej(p, '#000000', 0.35),
    svetla: smichej(p, '#ffffff', 0.9),
    upravena: p !== zaklad,
    kontrast: Math.round(kontrast(p, '#ffffff') * 100) / 100,
  };
}
