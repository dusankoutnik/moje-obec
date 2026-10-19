// OKLCH → sRGB a kontrast podle WCAG 2.1. Barevná schémata webu jsou definovaná v OKLCH (rovnoměrná světlost,
// snadné odvozování odstínů); kontrast se ověřuje výpočtem v testech, ne odhadem.
export type Oklch = [l: number, c: number, h: number];
export type Rgb01 = [number, number, number];

/** OKLCH → lineární sRGB → sRGB 0–1 (bez ořezu; mimo gamut = hodnota mimo 0–1) */
export function oklchNaSrgb([L, C, H]: Oklch): Rgb01 {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin: Rgb01 = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const g = (x: number) =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * Math.sign(x) * Math.abs(x) ** (1 / 2.4) - 0.055;
  return lin.map(g) as Rgb01;
}

export function vGamutu(c: Oklch, tolerance = 0.002): boolean {
  return oklchNaSrgb(c).every((x) => x >= -tolerance && x <= 1 + tolerance);
}

const orez = (x: number) => Math.min(1, Math.max(0, x));

export function oklchNaHex(c: Oklch): string {
  return (
    '#' +
    oklchNaSrgb(c)
      .map((x) =>
        Math.round(orez(x) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function oklchCss([l, c, h]: Oklch, alfa?: number): string {
  return `oklch(${+l.toFixed(3)} ${+c.toFixed(3)} ${+h.toFixed(1)}${alfa !== undefined ? ` / ${alfa}` : ''})`;
}

function jas(rgb: Rgb01): number {
  const k = (s: number) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map(orez) as Rgb01;
  return 0.2126 * k(r) + 0.7152 * k(g) + 0.0722 * k(b);
}

export function kontrastRgb(a: Rgb01, b: Rgb01): number {
  const [x, y] = [jas(a), jas(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** průhledná barva přes podklad (alfa kompozice v sRGB, jak ji kreslí prohlížeč) */
export function pres(horni: Rgb01, alfa: number, spodni: Rgb01): Rgb01 {
  return horni.map((x, i) => orez(x) * alfa + spodni[i]! * (1 - alfa)) as Rgb01;
}

export const BILA: Rgb01 = [1, 1, 1];
export const CERNA: Rgb01 = [0, 0, 0];
