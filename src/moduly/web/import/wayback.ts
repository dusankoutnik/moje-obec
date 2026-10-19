// Starý web, který už neběží, ale je ve Wayback Machine (web.archive.org): výpis zachycených adres (CDX API),
// stahování „syrových“ kopií bez lišty archivu (`…/web/<čas>id_/<url>`), dekódování starých kódování
// (windows-1250, iso-8859-2) a volitelná disková keš, aby opakovaný běh importu archiv zbytečně nezatěžoval.
//
// Stahovač pro importér je obal nad běžným Stahovacem: importér pracuje s PŮVODNÍMI adresami starého webu
// (http://www.obec.cz/aktualne/foto.jpg) a obal je sám přeloží na adresu v archivu u zvoleného času snímku.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Stahovac } from './typy.js';

export const WAYBACK = 'https://web.archive.org';

/** jeden řádek výpisu CDX */
export interface ZaznamCdx {
  /** čas snímku YYYYMMDDhhmmss */
  cas: string;
  url: string;
  typ: string;
}

/** výpis CDX (fl=timestamp,original,statuscode,mimetype) → záznamy; řádky, které nejsou CDX, přeskočí */
export function parsujCdx(text: string): ZaznamCdx[] {
  const out: ZaznamCdx[] = [];
  for (const radek of text.split('\n')) {
    const [cas, url, , typ] = radek.trim().split(/\s+/);
    if (!cas || !/^\d{14}$/.test(cas) || !url || !/^https?:\/\//.test(url)) continue;
    out.push({ cas, url: url.replace(/^(https?:\/\/[^/]+):80\//, '$1/'), typ: typ ?? '' });
  }
  return out;
}

/** adresa dotazu na CDX API: všechny zachycené HTML stránky (status 200) domény nebo předpony */
export function cdxDotaz(url: string, v: { predpona?: boolean; do?: string; od?: string } = {}): string {
  const q = new URLSearchParams({
    url,
    matchType: v.predpona ? 'prefix' : 'domain',
    fl: 'timestamp,original,statuscode,mimetype',
    collapse: 'urlkey',
    filter: 'statuscode:200',
  });
  if (v.od) q.set('from', v.od);
  if (v.do) q.set('to', v.do);
  return `${WAYBACK}/cdx/search/cdx?${q}`;
}

/** syrová kopie snímku (bez lišty archivu); archiv sám přesměruje na nejbližší existující snímek */
export function waybackUrl(cas: string, url: string): string {
  return `${WAYBACK}/web/${cas}id_/${url}`;
}

/** bajty HTML starého webu → text; kódování z hlavičky nebo <meta charset>, jinak UTF-8, a když není platné, windows-1250 */
export function dekodujHtml(data: Buffer, typ = ''): string {
  const hlavicka = data.subarray(0, 4096).toString('latin1');
  const deklarace =
    /charset=["']?([\w-]+)/i.exec(typ)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(hlavicka)?.[1] ?? '';
  let kod = deklarace.toLowerCase();
  // staré české weby deklarovaly iso-8859-1 / windows-1252, ale psaly v windows-1250 (jinak by nešla čeština)
  if (['iso-8859-1', 'windows-1252', 'latin1', 'us-ascii'].includes(kod)) kod = 'windows-1250';
  if (!kod) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      kod = 'windows-1250';
    }
  }
  try {
    return new TextDecoder(kod).decode(data);
  } catch {
    return new TextDecoder('windows-1250').decode(data);
  }
}

/**
 * Keš na disku pro `soubor()` (a tím i pro text stránek) — klíčem je adresa. Hodí se pro opakované běhy
 * (nanečisto → ostře) a pro testy; chybějící soubory (404) se neukládají.
 */
export function kesovanyStahovac(s: Stahovac, adresar: string): Stahovac {
  mkdirSync(adresar, { recursive: true });
  const cesta = (url: string) => join(adresar, createHash('sha1').update(url).digest('hex'));
  let zKese = 0;
  const soubor = async (url: string) => {
    const c = cesta(url);
    if (existsSync(c) && existsSync(`${c}.typ`)) {
      const data = readFileSync(c);
      zKese += data.length;
      return { data, typ: readFileSync(`${c}.typ`, 'utf8') };
    }
    const r = await s.soubor(url);
    if (r) {
      writeFileSync(c, r.data);
      writeFileSync(`${c}.typ`, r.typ);
    }
    return r;
  };
  return {
    get stazeno() {
      return s.stazeno + zKese;
    },
    soubor,
    async text(url) {
      const r = await soubor(url);
      if (!r) throw new Error(`nedostupné: ${url}`);
      return r.data.toString('utf8');
    },
    json: (url) => s.json(url),
  };
}

/**
 * Stahovač původních adres přes Wayback Machine: `soubor('http://www.obec.cz/a.jpg')` stáhne snímek
 * z času `cas` (nebo nejbližší). `text()` dekóduje stará kódování. Odkazy mimo archivovaný web projdou beze změny
 * (importér je stejně nestahuje — cizí obrázky zahodí).
 */
export function waybackStahovac(s: Stahovac, cas: string, jeArchivovany: (url: string) => boolean): Stahovac {
  const preloz = (url: string) => (jeArchivovany(url) ? waybackUrl(cas, url) : url);
  return {
    get stazeno() {
      return s.stazeno;
    },
    soubor: (url) => s.soubor(preloz(url)),
    async text(url) {
      const r = await s.soubor(preloz(url));
      if (!r) throw new Error(`nedostupné: ${url}`);
      return dekodujHtml(r.data, r.typ);
    },
    json: (url) => s.json(preloz(url)),
  };
}
