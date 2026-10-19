// HTML z editoru (a z importu) je vždy nedůvěryhodné → serverová sanitizace whitelistem.
// Povolená je jen struktura (nadpisy, odstavce, seznamy, odkazy, obrázky, jednoduché tabulky) — žádné barvy,
// velikosti písma, styly ani skripty, aby redaktor nemohl rozbít vzhled ani přístupnost webu.
import sanitizeHtml from 'sanitize-html';

const ZAKLAD: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'img',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'figure',
    'figcaption',
    'sub',
    'sup',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'width', 'height', 'data-soubor'],
    td: ['colspan', 'rowspan', 'data-row'],
    th: ['colspan', 'rowspan', 'scope'],
    // video z knihovny videí webu (vykreslí ho šablona obsahu, viz moduly/web/videa.ts)
    figure: ['data-video'],
  },
  // povolené třídy: galerie náhledů (z importu starých webů) a video
  allowedClasses: { figure: ['galerie', 'video'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    b: 'strong',
    i: 'em',
    strike: 's',
    del: 's',
    h1: 'h2', // jediný H1 na stránce je titulek
    h5: 'h4',
    h6: 'h4',
    // div se neprevádí na p (vznikaly vnořené odstavce) — nepovolený tag se zahodí a obsah zůstane
  },
  // odkazy bez cíle pryč (prázdné odstavce odstraní regulární výraz v sanitizuj)
  exclusiveFilter: (frame) => frame.tag === 'a' && !frame.attribs.href,
};

export function sanitizuj(html: string | null | undefined): string {
  return sanitizeHtml(String(html ?? ''), ZAKLAD)
    .replace(/<p>(\s|&nbsp;|<br \/>)*<\/p>/g, '')
    .trim();
}

/** obrázky, kterým chybí alternativní text (u obsahu webu je povinný) */
export function obrazkyBezAlt(html: string): number {
  let n = 0;
  sanitizeHtml(html, {
    allowedTags: ['img'],
    allowedAttributes: { img: ['alt', 'src'] },
    exclusiveFilter: (f) => {
      if (f.tag === 'img' && !String(f.attribs.alt ?? '').trim()) n++;
      return false;
    },
  });
  return n;
}

/**
 * Alternativní text z cizího zdroje (import): prázdný, když je obecný („Image“, „obrázek“, „DSC_0012“) nebo jen
 * opakuje název souboru — takový popis nevidomému nic neřekne a skrývá, že popis chybí. Prázdný alt = „chybí popis“:
 * redaktor ho uvidí ve správě a stránku s ním znovu nezveřejní, dokud popis nedoplní.
 */
export function altZeZdroje(alt: string | null | undefined, nazevSouboru = ''): string {
  const a = String(alt ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!a) return '';
  const norm = (x: string) =>
    x
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/, '')
      .replace(/[-_]?(\d+x\d+|scaled)$/, '')
      .replace(/[^a-z0-9]+/g, '');
  if (
    /^(image|img|obrazek|obrázek|foto|fotka|photo|picture|pic|graphic|grafika|logo|banner|dsc|dscn|p|wp)[\s_-]*\d*$/i.test(
      a,
    )
  )
    return '';
  if (/^(img|dsc|dscn|pxl|p|dji|gopr|mvimg|screenshot|snimek)[\s_-]*\d+/i.test(a)) return '';
  if (nazevSouboru && norm(a) === norm(nazevSouboru)) return '';
  return a;
}

/**
 * Hierarchie nadpisů v obsahu (pod jediným H1 stránky): úrovně se nepřeskakují — první nadpis je H2 a každý další
 * nejvýš o úroveň hlouběji než předchozí (h2 → h4 se stane h2 → h3). Pro import starých webů, kde se nadpisy volily
 * podle velikosti písma. Čeká sanitizované HTML (nadpisy bez atributů, h1 už převedené na h2).
 */
export function srovnejNadpisy(html: string): string {
  let posledni = 1;
  return html.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (_c, u: string, obsah: string) => {
    const uroven = Math.min(Number(u), posledni + 1);
    posledni = uroven;
    return `<h${uroven}>${obsah}</h${uroven}>`;
  });
}

/** počet obrázků v HTML, kterým chybí popis (prázdný alt) — pro přehledy ve správě */
export function pocetBezPopisu(html: string | null | undefined): number {
  return [...String(html ?? '').matchAll(/<img\b[^>]*>/gi)].filter(
    (m) => !/\balt="[^"]*[^"\s][^"]*"/i.test(m[0]),
  ).length;
}

/**
 * Při zobrazení: odkaz, jehož jediným obsahem je obrázek bez popisu (galerie z importu), by neměl přístupný název —
 * dostane obecný popisek funkce. Uložená data se nemění (prázdný alt dál znamená „chybí popis“).
 */
export function popiskyOdkazuSObrazkem(html: string): string {
  return html.replace(
    /<a href="([^"]*)">(\s*<img\b(?![^>]*\balt="[^"]*[^"\s])[^>]*>\s*)<\/a>/gi,
    '<a href="$1" aria-label="Obrázek bez popisu — zobrazit ve větší velikosti">$2</a>',
  );
}

/** prostý text z HTML (perex, hledání, SMS/e-mail) */
export function textZHtml(html: string | null | undefined): string {
  return sanitizeHtml(
    String(html ?? '')
      .replace(/<\/(p|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n'),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function escapujHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** prostý text → odstavce (zachová odkazy jako text) */
export function textNaHtml(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => `<p>${escapujHtml(o).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export function zkrat(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const rez = t.slice(0, max - 1);
  const mezera = rez.lastIndexOf(' ');
  return (mezera > max * 0.6 ? rez.slice(0, mezera) : rez).replace(/[,.;:\s]+$/, '') + '…';
}

/** Opakuje perex jen začátek článku? (perex z WordPressu = automatický výtah prvních vět) — pak ho na detailu
 *  nezobrazujeme dvakrát. Porovnávají se jen písmena a číslice bez diakritiky, prvních až 60 znaků. */
export function perexOpakujeText(perex: string | null | undefined, html: string | null | undefined): boolean {
  const klic = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const p = klic(String(perex ?? '')).slice(0, 60);
  if (!p) return true;
  return klic(textZHtml(html)).startsWith(p);
}
