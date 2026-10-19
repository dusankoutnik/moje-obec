// Normalizace kontaktů (telefon → E.164, e-mail → malá písmena) a práce s textem SMS.

// Telefon na +420…; vrací null, pokud nejde o telefon. Devítimístné číslo bez předvolby = ČR.
export function normalizujTelefon(vstup: unknown): string | null {
  const p = String(vstup ?? '').replace(/[ \-()./\u00a0]/g, '');
  if (/^\+\d{10,15}$/.test(p)) return p;
  if (/^00\d{10,14}$/.test(p)) return '+' + p.slice(2);
  if (/^\d{9}$/.test(p)) return '+420' + p;
  return null;
}

export function jeEmail(s: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? '').trim());
}

export function normalizujEmail(vstup: unknown): string | null {
  const s = String(vstup ?? '')
    .trim()
    .toLowerCase();
  return jeEmail(s) ? s : null;
}

export type Kontakt = { typ: 'telefon'; hodnota: string } | { typ: 'email'; hodnota: string };

export function rozpoznejKontakt(vstup: unknown): Kontakt | null {
  const s = String(vstup ?? '').trim();
  const email = normalizujEmail(s);
  if (email) return { typ: 'email', hodnota: email };
  const telefon = normalizujTelefon(s);
  if (telefon) return { typ: 'telefon', hodnota: telefon };
  return null;
}

// Telefon pro zobrazení: +420 777 123 456
export function formatujTelefon(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+420(\d{3})(\d{3})(\d{3})$/.exec(e164);
  return m ? `+420 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

// Bez diakritiky + typografické znaky na ASCII — SMS v GSM abecedě má 160 znaků, v UCS-2 jen 70.
export function bezDiakritiky(s: string): string {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/[„“”]/g, '"')
    .replace(/[‚‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ');
}

// Počet SMS segmentů pro text (po odstranění diakritiky): 160 znaků, zřetězené po 153.
export function smsSegmenty(text: string): number {
  const delka = bezDiakritiky(text).length;
  if (delka === 0) return 0;
  return delka <= 160 ? 1 : Math.ceil(delka / 153);
}
