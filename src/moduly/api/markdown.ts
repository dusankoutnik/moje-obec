// Jednoduchý převod Markdownu na HTML pro API (nadpisy, odstavce, odrážky, číslované seznamy, citace, oddělovač,
// tučné/kurzíva, odkazy, obrázky). Výsledek se vždy ještě sanitizuje (sanitizuj) — tady jde jen o tvar, ne o bezpečí.
import { escapujHtml } from '../../lib/html.js';

function radek(s: string): string {
  let t = escapujHtml(s);
  // obrázky a odkazy: ![popis](url) [text](url) — url bez mezer, uvozovky už jsou escapované
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, url: string) => `<img src="${url}" alt="${alt}">`,
  );
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url}">${text}</a>`,
  );
  t = t.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`);
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  return t;
}

export function markdownNaHtml(md: string): string {
  const radky = String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out: string[] = [];
  let odstavec: string[] = [];
  let seznam: { typ: 'ul' | 'ol'; polozky: string[] } | null = null;
  let citace: string[] = [];
  const zavriOdstavec = () => {
    if (odstavec.length) out.push(`<p>${odstavec.map(radek).join('<br>')}</p>`);
    odstavec = [];
  };
  const zavriSeznam = () => {
    if (seznam)
      out.push(
        `<${seznam.typ}>${seznam.polozky.map((p) => `<li>${radek(p)}</li>`).join('')}</${seznam.typ}>`,
      );
    seznam = null;
  };
  const zavriCitaci = () => {
    if (citace.length) out.push(`<blockquote><p>${citace.map(radek).join('<br>')}</p></blockquote>`);
    citace = [];
  };
  const zavriVse = () => {
    zavriOdstavec();
    zavriSeznam();
    zavriCitaci();
  };
  for (const r of radky) {
    const s = r.trimEnd();
    if (!s.trim()) {
      zavriVse();
      continue;
    }
    const nadpis = /^(#{1,6})\s+(.*)$/.exec(s);
    if (nadpis) {
      zavriVse();
      // jediný H1 na stránce je titulek → # i ## = h2, ### = h3, hlubší h4
      const uroven = Math.min(4, Math.max(2, nadpis[1]!.length));
      out.push(`<h${uroven}>${radek(nadpis[2]!.replace(/\s+#+\s*$/, ''))}</h${uroven}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(s)) {
      zavriVse();
      out.push('<hr>');
      continue;
    }
    const odrazka = /^\s*[-*+]\s+(.*)$/.exec(s);
    const cislo = /^\s*\d+[.)]\s+(.*)$/.exec(s);
    if (odrazka || cislo) {
      zavriOdstavec();
      zavriCitaci();
      const typ = odrazka ? 'ul' : 'ol';
      if (seznam && seznam.typ !== typ) zavriSeznam();
      seznam ??= { typ, polozky: [] };
      seznam.polozky.push((odrazka ?? cislo)![1]!);
      continue;
    }
    const cit = /^\s*>\s?(.*)$/.exec(s);
    if (cit) {
      zavriOdstavec();
      zavriSeznam();
      citace.push(cit[1]!);
      continue;
    }
    if (seznam && /^\s{2,}\S/.test(r)) {
      // pokračování položky seznamu
      seznam.polozky[seznam.polozky.length - 1] += ' ' + s.trim();
      continue;
    }
    zavriSeznam();
    zavriCitaci();
    odstavec.push(s.trim());
  }
  zavriVse();
  return out.join('\n');
}
