// Zkrácený popis zařízení z User-Agentu („Firefox · Windows“) pro přehled přihlášených zařízení. Celý User-Agent se
// neukládá (minimalizace údajů) — na rozpoznání „tohle jsem já na telefonu“ stačí prohlížeč a systém.

const PROHLIZECE: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMY: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function zkratProhlizec(ua: string | null | undefined): string | null {
  const s = String(ua ?? '').slice(0, 512);
  if (!s) return null;
  const p = PROHLIZECE.find(([re]) => re.test(s))?.[1];
  const sys = SYSTEMY.find(([re]) => re.test(s))?.[1];
  if (!p && !sys) return 'neznámé zařízení';
  return [p ?? 'prohlížeč', sys].filter(Boolean).join(' · ');
}
