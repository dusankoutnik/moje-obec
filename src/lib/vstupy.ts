// Čtení jednoduchých hodnot z URL (?strana=…) — nesmyslná hodnota nesmí skončit chybou databáze (500).

/** číslo stránky výpisu: celé číslo 1…max, cokoliv jiného (1.5, -3, Infinity, abc) = první stránka */
export function cisloStrany(v: unknown, max = 10_000): number {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,6}$/.test(s)) return 1;
  const n = Number(s);
  return n >= 1 && n <= max ? n : 1;
}
