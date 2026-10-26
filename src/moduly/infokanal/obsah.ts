// Obsah hlášení z formuláře: formátovaný e-mail (editor) → bezpečné HTML + prostý text, přílohy → odkazy.
// Chování podle VlastiKanálu (html.js): odkazy v prostém textu jako „text (adresa)“, odrážky „• “; přílohy jdou
// e-mailem jako soubory, když jsou dohromady malé (MAX_PRILOH_EMAILEM), jinak jen jako odkazy — odkazy jsou
// v e-mailu vždy (i kvůli schránkám, které přílohy zahazují).
import type { PrilohaHlaseni } from '../../db/types.js';
import { escapujHtml, sanitizuj, textNaHtml, textZHtml } from '../../lib/html.js';
import { lidskaVelikost } from '../../lib/soubory.js';
import { urlSouboru } from '../../web/soubory.js';

/** nejvýš příloh u jednoho hlášení (jako ve VlastiKanálu) */
export const MAX_PRILOH = 5;
/** součet velikostí příloh, do kterého se soubory přikládají k e-mailu; větší jdou jen jako odkazy
 *  (stovky e-mailů po 10 MB by zahltily SMTP obce i schránky příjemců) */
export const MAX_PRILOH_EMAILEM = 5 * 1024 * 1024;

const jeHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

/** relativní odkazy a obrázky (/soubory/…, /aktuality/…) → absolutní adresy webu obce (e-mail je mimo web) */
export function absolutniOdkazy(html: string, baseUrl: string): string {
  const zaklad = baseUrl.replace(/\/+$/, '');
  return html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${zaklad}/`);
}

/** HTML → prostý text e-mailu: odkazy „text (adresa)“, odrážky, číslování */
export function htmlNaTextEmailu(html: string): string {
  const seznamy: { ol: boolean; n: number }[] = [];
  const upraveno = html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = textZHtml(text);
      const h = href.replace(/&amp;/g, '&');
      return !t || t === h || `mailto:${t}` === h ? h.replace(/^mailto:/, '') : `${t} (${h})`;
    })
    .replace(/<(\/?)(ol|ul|li)\b[^>]*>/gi, (m, konec: string, tag: string) => {
      const z = tag.toLowerCase();
      if (z === 'li') {
        if (konec) return m;
        const s = seznamy[seznamy.length - 1];
        return s?.ol ? `${++s.n}. ` : '• ';
      }
      if (konec) seznamy.pop();
      else seznamy.push({ ol: z === 'ol', n: 0 });
      return '';
    })
    .replace(/<img\b[^>]*>/gi, '[obrázek]');
  return textZHtml(upraveno);
}

/** text e-mailu z formuláře (HTML z editoru, nebo prostý text bez JavaScriptu) → { text, html } */
export function zpracujEmail(vstup: string, baseUrl: string): { text: string; html: string | null } {
  const s = vstup.replace(/\r\n?/g, '\n').trim();
  if (!s) return { text: '', html: null };
  if (!jeHtml(s)) return { text: s, html: null };
  const html = absolutniOdkazy(sanitizuj(s), baseUrl);
  return { text: htmlNaTextEmailu(html), html: html || null };
}

/** text článku z formuláře → bezpečné HTML (prostý text na odstavce) */
export function zpracujClanek(vstup: string): string {
  const s = vstup.replace(/\r\n?/g, '\n').trim();
  return jeHtml(s) ? sanitizuj(s) : textNaHtml(s);
}

const adresa = (p: PrilohaHlaseni, baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, '')}${urlSouboru({ id: p.id, puvodni_nazev: p.nazev })}`;

/** seznam příloh pod článek na webu (relativní odkazy na soubory obce) */
export function prilohyHtml(prilohy: PrilohaHlaseni[], nadpis: string, baseUrl = ''): string {
  if (!prilohy.length) return '';
  const polozky = prilohy
    .map(
      (p) =>
        `<li><a href="${escapujHtml(adresa(p, baseUrl))}">${escapujHtml(p.nazev)}</a> (${lidskaVelikost(p.velikost)})</li>`,
    )
    .join('');
  return `<h2>${escapujHtml(nadpis)}</h2><ul>${polozky}</ul>`;
}

/** seznam příloh do prostého textu e-mailu */
export function prilohyText(prilohy: PrilohaHlaseni[], nadpis: string, baseUrl: string): string {
  if (!prilohy.length) return '';
  return `${nadpis}:\n${prilohy.map((p) => `• ${p.nazev} (${lidskaVelikost(p.velikost)}): ${adresa(p, baseUrl)}`).join('\n')}`;
}

/** přikládat soubory k e-mailu? (jinak jen odkazy) */
export function prilohyEmailem(prilohy: PrilohaHlaseni[]): boolean {
  const celkem = prilohy.reduce((s, p) => s + p.velikost, 0);
  return prilohy.length > 0 && celkem <= MAX_PRILOH_EMAILEM;
}
