// Výpadky vody SčVK (Severočeské vodovody a kanalizace). SčVK nemá API ani RSS; zdrojem jsou dva serverem
// vykreslené HTML seznamy na scvk.cz (plánované odstávky, havárie). Položka:
//   <a class="component__item is-shutdown|is-accident" href="/udalosti/<typ>/<slug>-<id>" title="Okres …, obec …,
//   část obce …"><h3 class="is-label">…</h3><div class="is-info">Zveřejněno: d.m.rrrr hh:mm</div>
//   <div class="is-info"><span>d.m.rrrr hh:mm - d.m.rrrr hh:mm</span></div><div class="is-text"><p>úryvek</p></div></a>
// Hlavní seznam ukazuje jen 10 nejnovějších — nepoužívat. Detail (component--detail) dává plný text a XLSX se
// seznamem dotčených odběrných míst. Zrušení/ukončení = událost zmizí ze seznamu A detail vrátí 404.
// Časy jsou pražské.
import { dekoduj } from './chmu.js';
import { prazskyCas } from './cas.js';

export const SCVK_WEB = 'https://www.scvk.cz';
export const SCVK_SEZNAMY = [
  '/vodovody-a-kanalizace/odstavky-a-havarie/planovane-odstavky/',
  '/vodovody-a-kanalizace/odstavky-a-havarie/havarie/',
];

export interface UdalostScvk {
  id: string;
  href: string;
  typ: 'planovana' | 'havarie';
  titulek: string;
  zverejneno: string;
  od: Date | null;
  do: Date | null;
  text: string;
  /** odkaz na seznam dotčených odběrných míst (XLSX/PDF) z detailu */
  soubor?: string | null;
}

const bezZnacek = (h: string | null | undefined) =>
  dekoduj(String(h ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

export function parsujSeznam(html: string): UdalostScvk[] {
  const vysledek: UdalostScvk[] = [];
  const re =
    /<a\b[^>]*href="(\/udalosti\/(planovane-odstavky|havarie)\/[^"]*?-(\d+))\/?"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const [, href, typ, id, vnitrek] = m as unknown as [string, string, string, string, string];
    const titulek = bezZnacek(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(vnitrek)?.[1]);
    if (!titulek) continue;
    const info = [...vnitrek.matchAll(/<div class="is-info">([\s\S]*?)<\/div>/g)].map((x) => bezZnacek(x[1]));
    const zverejneno = (info.find((i) => /Zveřejněno/i.test(i)) ?? '').replace(/Zveřejněno:?\s*/i, '');
    const interval =
      info.find((i) => /\d{1,2}\.\s?\d{1,2}\.\s?\d{4}/.test(i) && !/Zveřejněno/i.test(i)) ?? '';
    const [od, do_] = interval.split(/\s[-–]\s/);
    vysledek.push({
      id,
      href,
      typ: typ === 'havarie' ? 'havarie' : 'planovana',
      titulek,
      zverejneno,
      od: prazskyCas(od),
      do: prazskyCas(do_),
      text: bezZnacek(/<div class="is-text">([\s\S]*?)<\/div>/.exec(vnitrek)?.[1]),
    });
  }
  return vysledek;
}

/** detail události: plný text a odkaz na seznam dotčených míst */
export function parsujDetail(html: string): { text: string; soubor: string | null } {
  const blok = /component--detail[\s\S]*?(?=<footer|<\/main)/.exec(html)?.[0] ?? html;
  const odstavce = [...blok.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => bezZnacek(x[1])).filter(Boolean);
  const soubor = /href="(\/res\/[^"]+\.(?:xlsx?|pdf)[^"]*)"/i.exec(blok)?.[1];
  return { text: odstavce.join('\n\n'), soubor: soubor ? SCVK_WEB + dekoduj(soubor) : null };
}

const mala = (s: string) => s.toLocaleLowerCase('cs').trim();

/** obce z titulku („…, obec Hrubá Skála, Troskovice, část obce …“) */
export function obceZTitulku(titulek: string): string[] {
  const m = /(?:^|,\s*)obec\s+(.+?)(?:,\s*část obce\s|$)/i.exec(titulek);
  return m
    ? m[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** části obce z titulku („…, část obce Jivina, Krčkovice“) */
export function castiZTitulku(titulek: string): string[] {
  const m = /část obce\s+(.+)$/i.exec(titulek);
  return m
    ? m[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** týká se událost naší obce? (celé jméno obce v seznamu obcí titulku, ne jen stejně pojmenovaná část jinde) */
export function jeNaseObec(titulek: string, obec: string): boolean {
  const hledana = mala(obec);
  return !!hledana && obceZTitulku(titulek).some((o) => mala(o) === hledana);
}
