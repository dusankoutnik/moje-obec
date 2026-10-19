// Pomůcky pro čtení HTML starých webů bez DOM knihovny: entity, menu z vnořených <ul>/<li>, videa.
import { parsujOdkazVidea } from '../videa.js';
import type { ImportMenu, ImportVideo } from './typy.js';

const POJMENOVANE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bdquo: '„',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  copy: '©',
  raquo: '»',
  laquo: '«',
};

export function dekodujEntity(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (cele, n: string) => POJMENOVANE[n.toLowerCase()] ?? cele);
}

export function textTagu(html: string): string {
  return dekodujEntity(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Najde v HTML menu (první <ul>, jehož třída obsahuje `trida`, výchozí „menu“) a vrátí strom položek.
 * Funguje pro WordPress (ul.menu), většinu šablon i pro mnoho proprietárních CMS (ul s vnořenými ul).
 */
export function parsujMenu(
  html: string,
  trida: RegExp = /\bmenu\b|hmenu|nav/i,
  zaklad?: string,
): ImportMenu[] {
  const zacatky = [...html.matchAll(/<ul\b([^>]*)>/gi)];
  const start = zacatky.find((m) => trida.test(/class\s*=\s*"([^"]*)"/i.exec(m[1] ?? '')?.[1] ?? ''));
  if (start?.index === undefined) return [];
  // najít konec odpovídajícího </ul>
  const re = /<(\/?)ul\b[^>]*>/gi;
  re.lastIndex = start.index;
  let hloubka = 0;
  let konec = html.length;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    hloubka += m[1] ? -1 : 1;
    if (hloubka === 0) {
      konec = m.index + m[0].length;
      break;
    }
  }
  const usek = html.slice(start.index, konec);
  // tokenizace: <ul>, </ul>, <li>, </li>, <a ...>text</a>
  const koren: ImportMenu[] = [];
  const zasobnik: ImportMenu[][] = [];
  let aktualni: ImportMenu[] | null = null;
  let posledni: ImportMenu | null = null;
  const tok = /<(\/?)(ul|li)\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = tok.exec(usek); m; m = tok.exec(usek)) {
    if (m[2]?.toLowerCase() === 'ul') {
      if (!m[1]) {
        const seznam: ImportMenu[] = aktualni === null ? koren : (posledni?.deti ?? aktualni);
        if (aktualni !== null) zasobnik.push(aktualni);
        aktualni = seznam;
      } else {
        aktualni = zasobnik.pop() ?? null;
      }
    } else if (m[3] !== undefined && aktualni) {
      const href = /href\s*=\s*"([^"]*)"/i.exec(m[3])?.[1] ?? null;
      const titulek = textTagu(m[4] ?? '') || dekodujEntity(/title\s*=\s*"([^"]*)"/i.exec(m[3])?.[1] ?? '');
      let url: string | null = href ? dekodujEntity(href) : null;
      if (url && zaklad) {
        try {
          url = new URL(url, zaklad).href;
        } catch {
          url = null;
        }
      }
      posledni = { titulek, url: url && !url.startsWith('#') ? url : null, deti: [] };
      aktualni.push(posledni);
    }
  }
  return koren;
}

/** zástupná značka videa v HTML během importu (přežije sanitizaci jako text odstavce) */
export const ZNACKA_VIDEA = (i: number) => `[[mo-video:${i}]]`;

function atr(tag: string, nazev: string): string | null {
  const m = new RegExp(`\\s${nazev}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? dekodujEntity(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/**
 * Najde v HTML starého webu videa a nahradí je zástupnou značkou `[[mo-video:N]]` (importér z ní udělá video
 * v knihovně videí webu). Rozpozná: přehrávač YouTube/Vimeo v <iframe> (i v bloku „Vložení“ Gutenbergu),
 * <video> se <source> nebo src (WordPress [video], běžné HTML), shortcody [video …] a [embed]URL[/embed].
 * Cizí <iframe> (mapy, formuláře) nechává být — ty importér zahodí jako dřív.
 */
export function najdiVidea(html: string, zaklad?: string): { html: string; videa: ImportVideo[] } {
  const videa: ImportVideo[] = [];
  // jen http(s) — javascript:, data: apod. se nikdy nestanou videem ani odkazem
  const abs = (u: string | null) => {
    if (!u) return undefined;
    try {
      const x = new URL(u, zaklad);
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : undefined;
    } catch {
      return undefined;
    }
  };
  const pridej = (v: ImportVideo) => {
    // stejné video dvakrát za sebou (iframe + odkaz na totéž) → jedna značka
    const i = videa.findIndex((x) => x.zdroj === v.zdroj && (x.id ?? x.url) === (v.id ?? v.url));
    if (i >= 0) return `<p>${ZNACKA_VIDEA(i)}</p>`;
    videa.push(v);
    return `<p>${ZNACKA_VIDEA(videa.length - 1)}</p>`;
  };
  const zOdkazu = (url: string | undefined, nazev?: string): ImportVideo | null => {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const p = parsujOdkazVidea(url);
    if (p) return { zdroj: p.zdroj, id: p.id, nazev: nazev || undefined };
    if (/\.(mp4|m4v|webm)(\?|#|$)/i.test(url))
      return { zdroj: 'soubor', url: url.replace(/\?_=\d+$/, ''), nazev };
    return null;
  };
  const zVidea = (tag: string, vnitrek: string): ImportVideo | null => {
    const zdroje = [
      atr(tag, 'src'),
      ...[...vnitrek.matchAll(/<source\b[^>]*>/gi)].map((m) => atr(m[0], 'src')),
    ]
      .map(abs)
      .filter((u): u is string => !!u);
    const mp4 =
      zdroje.find((u) => /\.(mp4|m4v)(\?|$)/i.test(u)) ?? zdroje.find((u) => /\.webm(\?|$)/i.test(u));
    if (!mp4) return null;
    return { zdroj: 'soubor', url: mp4.replace(/\?_=\d+$/, ''), plakatUrl: abs(atr(tag, 'poster')) };
  };

  let h = html;
  // Gutenberg: <figure class="wp-block-embed …"><div class="wp-block-embed__wrapper">iframe nebo URL</div>
  // <figcaption>…</figcaption></figure> a <figure class="wp-block-video"><video …></video></figure>
  h = h.replace(
    /<figure\b[^>]*class="[^"]*wp-block-(?:embed|video)[^"]*"[^>]*>([\s\S]*?)<\/figure>/gi,
    (cele, vnitrek: string) => {
      const popisek = textTagu(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i.exec(vnitrek)?.[1] ?? '');
      const iframe = /<iframe\b[^>]*>/i.exec(vnitrek)?.[0];
      const video = /<video\b([^>]*)>([\s\S]*?)<\/video>/i.exec(vnitrek);
      const url = /https?:\/\/[^\s<"']+/.exec(
        textTagu(vnitrek.replace(/<figcaption[\s\S]*?<\/figcaption>/i, '')),
      )?.[0];
      const v =
        (iframe
          ? zOdkazu(
              abs(atr(iframe, 'src') ?? atr(iframe, 'data-src')),
              popisek || atr(iframe, 'title') || undefined,
            )
          : null) ??
        (video ? zVidea(video[0], video[2] ?? '') : null) ??
        zOdkazu(url, popisek);
      if (!v) return cele;
      if (popisek && !v.nazev) v.nazev = popisek;
      return pridej(v);
    },
  );
  // samostatné <iframe> přehrávače
  h = h.replace(/<iframe\b[^>]*>(?:[\s\S]*?<\/iframe>)?/gi, (cele) => {
    const titulek = atr(cele, 'title');
    const v = zOdkazu(
      abs(atr(cele, 'src') ?? atr(cele, 'data-src')),
      titulek && !/^(youtube|vimeo)?\s*video player$/i.test(titulek) ? titulek : undefined,
    );
    return v ? pridej(v) : cele;
  });
  // <video>…</video> (WordPress [video] po vykreslení: div.wp-video > video.wp-video-shortcode > source + odkaz)
  h = h.replace(/<video\b[^>]*>([\s\S]*?)<\/video>/gi, (cele, vnitrek: string) => {
    const v = zVidea(cele, vnitrek);
    return v ? pridej(v) : cele;
  });
  // nevykreslené shortcody: [video mp4="…" poster="…"][/video], [embed]URL[/embed]
  h = h.replace(/\[video\b([^\]]*)\](?:\s*\[\/video\])?/gi, (cele, atributy: string) => {
    const tag = `<video ${atributy}>`;
    const url = abs(atr(tag, 'mp4') ?? atr(tag, 'm4v') ?? atr(tag, 'webm') ?? atr(tag, 'src'));
    if (!url) return cele;
    return pridej({ zdroj: 'soubor', url: url.replace(/\?_=\d+$/, ''), plakatUrl: abs(atr(tag, 'poster')) });
  });
  h = h.replace(/\[embed[^\]]*\]\s*([^[\s]+)\s*\[\/embed\]/gi, (cele, url: string) => {
    const v = zOdkazu(abs(dekodujEntity(url)));
    return v ? pridej(v) : cele;
  });
  return { html: h, videa };
}
