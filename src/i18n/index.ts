// Překladová funkce t('sekce.klic', {param}) — texty z ./cs.ts. Chybějící klíč vrací samotný klíč (ať je vidět).
import { cs } from './cs.js';

export type Jazyk = 'cs';
const slovniky: Record<Jazyk, Record<string, unknown>> = { cs };

export type T = (klic: string, params?: Record<string, string | number>) => string;

export function vytvorT(jazyk: Jazyk = 'cs'): T {
  const slovnik = slovniky[jazyk];
  return (klic, params) => {
    const hodnota = klic
      .split('.')
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        slovnik,
      );
    let text = typeof hodnota === 'string' ? hodnota : klic;
    if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
    return text;
  };
}

export { cs };
