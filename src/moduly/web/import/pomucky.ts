// Pomůcky importu: porovnání titulků, odhad rozpočtového dokumentu, kontrola výstupu adaptérů a práce s adresami
// a atributy HTML. Čisté funkce bez DB.
import { z } from 'zod';
import type { TypRozpoctu } from '../../deska/sluzba.js';

/** titulek pro porovnání duplicit: bez diakritiky, interpunkce a velikosti písmen */
export function klicTitulku(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** stejný nebo podobný titulek (jeden obsahuje druhý, u krátkých jen shoda) */
export function podobnyTitulek(a: string, b: string): boolean {
  const x = klicTitulku(a);
  const y = klicTitulku(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [kratsi, delsi] = x.length < y.length ? [x, y] : [y, x];
  return kratsi.length >= 12 && delsi.includes(kratsi);
}

// kontrola výstupu adaptérů: vadná položka (neplatné datum, chybějící adresa) se přeskočí a zapíše do chyb,
// místo aby shodila celý import
const platneDatum = z.date().refine((d) => !Number.isNaN(d.getTime()), 'neplatné datum');
export const SCHEMA_STRANKY = z.object({
  klic: z.string().min(1),
  url: z.string().min(1),
  titulek: z.string(),
  html: z.string(),
  perex: z.string().optional(),
  rodic: z.string().nullish(),
  poradi: z.number().finite().optional(),
  datum: platneDatum.nullish(),
});
export const SCHEMA_CLANKU = z.object({
  url: z.string().min(1),
  titulek: z.string(),
  html: z.string(),
  perex: z.string().optional(),
  datum: platneDatum,
  kategorie: z.string().nullish(),
  obrazekUrl: z.string().nullish(),
  obrazekAlt: z.string().nullish(),
});
export const SCHEMA_DOKUMENTU = z.object({
  url: z.string().min(1),
  nazev: z.string(),
  html: z.string(),
  vyvesenoOd: platneDatum,
  sejmutoDo: platneDatum.nullish(),
  kategorie: z.string(),
  cisloJednaci: z.string().optional(),
  prilohy: z.array(z.object({ url: z.string().min(1), nazev: z.string().optional() })).optional(),
});

/** popis chyby validace položky ze zdroje (bez dat položky) */
export function chybaSchematu(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || 'položka'}: ${i.message}`).join('; ');
}

export const DOKUMENTY = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
export const OBRAZKY = /\.(jpe?g|png|gif|webp)$/i;

/** z textu titulku odhadne druh rozpočtového dokumentu a rok (pro kategorii „rozpočet“) */
export function odhadniRozpocet(nazev: string, datum: Date): { typ: TypRozpoctu; rok: number } | null {
  const n = nazev.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const rokZNazvu = /\b(20\d\d)\b/.exec(n)?.[1];
  const rok = rokZNazvu ? Number(rokZNazvu) : datum.getFullYear();
  const navrh = /navrh/.test(n);
  if (/rozpoctov\w* opatreni|\bro\s*c\.?\s*\d/.test(n)) return { typ: 'rozpoctove_opatreni', rok };
  if (/strednedob\w* vyhled|vyhled\w* rozpoct|\bsvr\b/.test(n))
    return { typ: navrh ? 'navrh_vyhledu' : 'vyhled', rok };
  if (/zaverecn\w* uc|\bzu\b/.test(n)) return { typ: navrh ? 'navrh_zu' : 'zaverecny_ucet', rok };
  if (/rozpoc/.test(n))
    return { typ: navrh ? 'navrh_rozpoctu' : 'rozpocet', rok: rokZNazvu ? rok : navrh ? rok + 1 : rok };
  return null;
}

/** text menu z VELKÝCH PÍSMEN na běžný („AKTUÁLNĚ“ → „Aktuálně“) */
export function hezkyTitulek(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t === t.toUpperCase() && /[A-ZÁ-Ž]{3}/.test(t) ? t.charAt(0) + t.slice(1).toLowerCase() : t;
}

/** jméno souboru z URL: parametr original= (Galileo e_download.php), jinak poslední část cesty */
export function jmenoSouboru(url: string): string {
  try {
    const u = new URL(url);
    const p = u.searchParams.get('original') ?? u.searchParams.get('filename') ?? u.searchParams.get('name');
    return dekodujBezpecne(p || u.pathname.split('/').pop() || 'soubor');
  } catch {
    return 'soubor';
  }
}

export function atribut(tag: string, nazev: string): string | null {
  const m = new RegExp(`\\s${nazev}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return dekoduj(m[2] ?? m[3] ?? m[4] ?? '');
}

export function dekoduj(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export function dekodujBezpecne(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // %zz a podobné vadné kódování: necháme, jak je
  }
}

export function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function absolutni(url: string, zaklad: string): string | null {
  try {
    const u = new URL(url, zaklad);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
