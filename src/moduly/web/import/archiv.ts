// Adaptér „archiv“: články ze STARÉHO webu obce, který už neběží — z Wayback Machine (web.archive.org) nebo
// z HTTrack zrcadla. Staré weby obcí (2000–2015) byly statické stránky nebo jednoduché PHP systémy bez API, a co
// web, to jiné HTML. Adaptér proto:
//   1. projde zachycené HTML stránky (výpis CDX, viz wayback.ts),
//   2. na každou pustí „vytěžovače“ — funkce, které z HTML jednoho typu webu vytáhnou články (titulek, text, datum),
//   3. stejné články z více stránek/snímků sloučí (titulek + datum, nebo id článku), u článku se seznamem
//      a samostatným detailem si stáhne detail (celý text),
//   4. vrací jen články s datem zveřejnění z obsahu stránky; ty bez data vypíše (`bezData`) k ručnímu posouzení.
//
// Nový typ starého webu = nový vytěžovač (pár regulárních výrazů nad HTML) — viz docs/IMPORT.md.
// Stránky, které jsou úřední deskou, galerií apod., vytěžovač prostě nevrací.
import { casPraha } from '../../../lib/datum.js';
import { slugify } from '../../../lib/slug.js';
import { dekodujEntity, textTagu } from './html-pomoc.js';
import { klicTitulku } from './pomucky.js';
import type { ImportClanek, ImportniZdroj, ImportStranka, Stahovac } from './typy.js';
import { dekodujHtml, waybackUrl, type ZaznamCdx } from './wayback.js';

/** článek, jak ho našel vytěžovač na jedné stránce */
export interface NalezenyClanek {
  titulek: string;
  /** HTML textu (odkazy jsou už absolutní podle adresy stránky) */
  html: string;
  /** datum zveřejnění z obsahu (ne čas snímku archivu); null = stránka ho neuvádí */
  datum: Date | null;
  /** samostatná stránka s celým textem (seznam ukazuje jen začátek) */
  detailUrl?: string | null;
  /** stabilní id článku ve starém systému (sloučí výskyty na více stránkách) */
  id?: string | null;
  /** datum není u článku, ale odvozené z kontextu (datum aktualizace stránky, jen měsíc…) → do reportu */
  datumOdvozene?: string | null;
}

export interface Vytezovac {
  nazev: string;
  /** články na stránce (prázdné pole = stránka tohoto typu není nebo článek nemá) */
  clanky(html: string, url: string): NalezenyClanek[];
  /** celý text z detailu článku (když vytěžovač vrací detailUrl) */
  detail?(html: string, url: string): string | null;
}

export interface VolbyArchivu {
  /** kořen archivovaného webu, např. http://www.obec.cz/ nebo http://archiv.obec.cz/www.obec.cz/ */
  zaklad: string;
  /** stahovač (obvykle kesovanyStahovac); stránky se stahují přes `adresaSnimku` */
  stahovac: Stahovac;
  /** adresa konkrétního snímku stránky (výchozí Wayback `…/web/<čas>id_/<url>`; u místního zrcadla `(_, u) => u`) */
  adresaSnimku?: (cas: string, url: string) => string;
  /** stránky k prohledání (z CDX); u více snímků téže adresy se projdou všechny */
  stranky: ZaznamCdx[];
  vytezovace: Vytezovac[];
  /** neutrální název kategorie článků (importér ho namapuje přes kategorieAktualit) */
  kategorie?: string;
  /** adresy článků, které se nemají importovat (ruční posouzení — osobní údaje apod.) */
  vynechat?: string[];
  /** články, jejichž text odpovídá výrazu, se přeskočí (např. zprávy o změnách starého webu samotného) */
  vynechatText?: RegExp;
  /** ruční titulky podle adresy článku (odvozené titulky ze zpráv bez nadpisu bývají kostrbaté) */
  titulky?: Record<string, string>;
  log?: (zprava: string) => void;
}

/** výsledek přípravy (pro výpis nanečisto a report) */
export interface ClanekArchivu extends ImportClanek {
  /** na kterých stránkách se článek našel */
  vyskyty: string[];
  datumOdvozene?: string | null;
}

const MESICE = [
  ['leden', 'ledna'],
  ['únor', 'února'],
  ['březen', 'března'],
  ['duben', 'dubna'],
  ['květen', 'května'],
  ['červen', 'června'],
  ['červenec', 'července'],
  ['srpen', 'srpna'],
  ['září', 'září'],
  ['říjen', 'října'],
  ['listopad', 'listopadu'],
  ['prosinec', 'prosince'],
];

/** „19. dubna 2003“ → 'YYYY-MM-DD'; „Září 2005“ (jen měsíc) → první den měsíce s příznakem `jenMesic` */
export function slovniDatum(s: string): { datum: string; jenMesic: boolean } | null {
  const t = s.toLowerCase();
  // pozor na pořadí: „červenec“ dřív než „červen“
  const vzory = MESICE.map((m, i) => ({ i, m })).sort((a, b) => b.m[0]!.length - a.m[0]!.length);
  const plne = /(\d{1,2})\.\s*([a-záčďéěíňóřšťúůýž]+)\s+((?:19|20)\d\d)/.exec(t);
  if (plne) {
    const i = vzory.find((v) => v.m.includes(plne[2]!))?.i;
    if (i !== undefined)
      return {
        datum: `${plne[3]}-${String(i + 1).padStart(2, '0')}-${plne[1]!.padStart(2, '0')}`,
        jenMesic: false,
      };
  }
  const mes = /^([a-záčďéěíňóřšťúůýž]+)\s+((?:19|20)\d\d)\b/.exec(t.trim());
  if (mes) {
    const i = vzory.find((v) => v.m.includes(mes[1]!))?.i;
    if (i !== undefined) return { datum: `${mes[2]}-${String(i + 1).padStart(2, '0')}-01`, jenMesic: true };
  }
  return null;
}

/** „27.04.2011“, „4. 4. 2009“ → 'YYYY-MM-DD' (první datum v textu); jen roky 1990–2099 */
export function datumZTextu(s: string): string | null {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*((?:19|20)\d\d)/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mes = Number(m[2]);
    if (d >= 1 && d <= 31 && mes >= 1 && mes <= 12)
      return `${m[3]}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const iso = /\b((?:19|20)\d\d)-(\d\d)-(\d\d)\b/.exec(s);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

/** relativní odkazy a obrázky → absolutní podle adresy stránky (importér pak pozná vlastní média) */
export function absolutniOdkazy(html: string, url: string): string {
  return html.replace(
    /\s(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (cele, atr: string, _h, a, b, c) => {
      const hodnota = dekodujEntity((a ?? b ?? c ?? '') as string).trim();
      if (!hodnota || /^(#|mailto:|tel:|javascript:)/i.test(hodnota)) return cele;
      try {
        return ` ${atr}="${new URL(hodnota, url).href.replace(/"/g, '%22')}"`;
      } catch {
        return cele;
      }
    },
  );
}

/** vyčištění HTML ze starých šablon: tabulky rozložení, <font>, zarovnání, styly → prostý obsah */
export function vycistiStareHtml(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|form)[\s\S]*?<\/\1>/gi, '')
      // rozložení tabulkou: buňky → odstavce (skutečné datové tabulky v článcích těchto webů nebyly)
      .replace(/<\/?(table|tbody|thead|tr)\b[^>]*>/gi, '')
      .replace(/<td\b[^>]*>/gi, '<p>')
      .replace(/<\/td>/gi, '</p>')
      .replace(/<\/?(font|span|div|center)\b[^>]*>/gi, ' ')
      // drobné ozdobné obrázky šablony (odrážky, mezery)
      .replace(/<img\b[^>]*\/(gif|ikony?|icons?)\/[^>]*>/gi, '')
      .replace(/<img\b[^>]*(spacer|odrazka|blank|pixel)[^>]*>/gi, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

/** text článku z prostého textu se zalomeními (<br>) → odstavce */
function odstavce(html: string): string {
  const casti = html
    .split(/(?:<br\s*\/?>\s*){2,}|<\/?p\b[^>]*>/i)
    .map((c) => c.trim())
    // prázdné a navigační zbytky („<< Zpět“) pryč
    .filter((c) => /[\p{L}\d]/u.test(textTagu(c)) || /<img/i.test(c));
  return casti.map((c) => `<p>${c}</p>`).join('\n');
}

// ---------------- vytěžovače ----------------

/**
 * TopDesign (top-design.cz, PHP systém obecních webů kolem 2007–2012): aktuality jako tabulky
 * `td.aktualne-nadpis` + `td.aktualne-text` + `td.aktualne_datum` („Vložil: Jméno | 27.04.2011“).
 * Jméno vkladatele se nepřebírá.
 */
export const topDesignAktuality: Vytezovac = {
  nazev: 'TopDesign aktuality',
  clanky(html, url) {
    const out: NalezenyClanek[] = [];
    for (const kus of html.split(/<td class="aktualne-nadpis"[^>]*>/i).slice(1)) {
      const titulek = textTagu(kus.slice(0, kus.search(/<\/td>/i)));
      const text = /<td class="aktualne-text"[^>]*>([\s\S]*?)<\/td>/i.exec(kus)?.[1];
      if (!titulek || text === undefined) continue;
      const datumTxt = /<td class="aktualne_datum"[^>]*>([\s\S]*?)<\/td>/i.exec(kus)?.[1] ?? '';
      const d = datumZTextu(datumTxt);
      out.push({
        titulek,
        html: odstavce(absolutniOdkazy(vycistiStareHtml(text), url)),
        datum: d ? casPraha(d, 12) : null,
      });
    }
    return out;
  },
};

/**
 * TopDesign — rubriky článků (`index.php?akce=in&fn=clanky_list&kat=N`): `div.clanek-datum` (2008-02-22 14:51:55),
 * `a.clanek-nadpis` s odkazem na detail (`fn=clanky_view&clanek=ID`), `span.clanek-text` = začátek textu.
 * Detail: `<p class="clanek-text">` odstavce. Úřední deska TopDesignu používá jiné třídy (`deska`), sem nepatří.
 */
export const topDesignClanky: Vytezovac = {
  nazev: 'TopDesign články',
  clanky(html, url) {
    const out: NalezenyClanek[] = [];
    for (const kus of html.split(/class="clanek-datum"/i).slice(1)) {
      const datum = /(\d{4}-\d\d-\d\d) (\d\d):(\d\d)/.exec(kus);
      const odkaz = /<a href="([^"]*clanek=(\d+)[^"]*)"[^>]*class="clanek-nadpis"[^>]*>([\s\S]*?)<\/a>/i.exec(
        kus,
      );
      if (!datum || !odkaz) continue;
      const perex = /<span class="clanek-text">([\s\S]*?)<\/span>/i.exec(kus)?.[1] ?? '';
      out.push({
        titulek: textTagu(odkaz[3]!).replace(/^>>\s*/, ''),
        html: odstavce(absolutniOdkazy(vycistiStareHtml(perex), url)),
        datum: casPraha(datum[1]!, Number(datum[2]), Number(datum[3])),
        detailUrl: new URL(dekodujEntity(odkaz[1]!), url).href,
        id: `clanek-${odkaz[2]}`,
      });
    }
    return out;
  },
  detail(html, url) {
    // odstavce <p class="clanek-text"> nejsou vždy uzavřené → celý obsah buňky od prvního z nich do </td>
    const i = html.search(/<p class="clanek-text">/i);
    if (i < 0) return null;
    const bunka = html.slice(i, i + html.slice(i).search(/<\/td>/i));
    return odstavce(
      absolutniOdkazy(vycistiStareHtml(bunka.replace(/<p class="clanek-text">/gi, '<p>')), url),
    );
  },
};

/** titulek z textu novinky bez nadpisu: tučný začátek, jinak první věta (zkrácená na celé slovo) */
export function titulekZTextu(html: string): string {
  // tučný úsek na začátku (u zpráv uvozených datem kdekoliv v první větě)
  const tucny = /<(b|strong)>([\s\S]*?)<\/\1>/i.exec(html);
  let t = tucny && tucny.index < 250 ? textTagu(tucny[2]!) : '';
  if (t === t.toUpperCase()) t = t.charAt(0) + t.slice(1).toLowerCase();
  t = t.replace(/^[-–\s]+/, '');
  if (t.length >= 6 && t.length <= 120 && !/^(zde|více|fotografie)$/i.test(t))
    return t.replace(/[.:,!]$/, '');
  const text = textTagu(html);
  const veta = /^(.{20,}?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  if (veta.length <= 90) return veta.replace(/\.$/, '');
  return veta.slice(0, 90).replace(/\s+\S*$/, '') + '…';
}

/**
 * Statické stránky TopDesign (2002–2006): novinky jako odstavce s odrážkou `<img src="gif/odrazkaN.gif">`
 * v bloku „Aktuální informace“ / „Novinky“, bez data u jednotlivé zprávy. Datum: explicitní na začátku zprávy
 * („19. dubna 2003 se konal…“), jinak „Poslední aktualizace: 22. listopadu 2002“ stránky (= odvozené, do reportu).
 */
export const topDesignStatickeNovinky: Vytezovac = {
  nazev: 'TopDesign statické novinky',
  clanky(html, url) {
    if (!/odrazka\d*\.gif/i.test(html)) return [];
    const telo = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    const zacatek = telo.search(/Aktu[aá]ln[ií]\s+informace|Novinky na na[sš]ich/i);
    const konec = telo.search(/stru[čc]n[áa] charakteristika|Zp[ěe]t na hlavn[ií] stranu|©\s*Meteopress/i);
    const usek = telo.slice(zacatek >= 0 ? zacatek : 0, konec > zacatek ? konec : undefined);
    const hlavicka = zacatek >= 0;
    const aktualizace = slovniDatum(
      textTagu(/Posledn[ií] aktualizace:([\s\S]{0,160})/i.exec(telo)?.[1] ?? ''),
    );
    const out: NalezenyClanek[] = [];
    for (const kus of usek.split(/<img[^>]*odrazka\d*\.gif[^>]*>/i).slice(1)) {
      const cisty = odstavce(absolutniOdkazy(vycistiStareHtml(kus), url))
        // konec bloku (nadpis další sekce) do zprávy nepatří
        .replace(/<p>[^<]*¨{5,}[\s\S]*$/, '');
      const text = textTagu(cisty);
      if (text.length < 40) continue;
      const vlastni = slovniDatum(text.slice(0, 40));
      const iso = datumZTextu(text.slice(0, 12));
      let datum: string | null = null;
      let odvozene: string | null = null;
      if (iso && text.slice(0, 12).includes(iso.slice(0, 4))) datum = iso;
      else if (vlastni && text.toLowerCase().trimStart().indexOf(vlastni.datum.slice(0, 4)) < 30) {
        datum = vlastni.datum;
        if (vlastni.jenMesic) odvozene = 'u zprávy je jen měsíc a rok';
      } else if (!hlavicka) continue;
      // bez bloku novinek bereme jen zprávy s vlastním datem (jinak by to byly odrážky obsahu stránky)
      else if (aktualizace) {
        datum = aktualizace.datum;
        odvozene = `datum aktualizace stránky (${aktualizace.datum})`;
      }
      out.push({
        titulek: titulekZTextu(cisty),
        html: cisty,
        datum: datum ? casPraha(datum, 12) : null,
        datumOdvozene: odvozene,
      });
    }
    // rozházené HTML šablony: odstavec patřící další zprávě bývá i na konci předchozí → z předchozí pryč
    for (let i = 0; i + 1 < out.length; i++) {
      const dalsi = new Set(out[i + 1]!.html.split('\n').map((p) => klicTitulku(textTagu(p))));
      out[i]!.html = out[i]!.html.split('\n')
        .filter((p, j) => j === 0 || !dalsi.has(klicTitulku(textTagu(p))))
        .join('\n');
    }
    return out;
  },
};

export const VYTEZOVACE: Record<string, Vytezovac> = {
  'topdesign-aktuality': topDesignAktuality,
  'topdesign-clanky': topDesignClanky,
  'topdesign-staticke': topDesignStatickeNovinky,
};

// ---------------- adaptér ----------------

export class ArchivZdroj implements ImportniZdroj {
  readonly nazev = 'archiv';
  readonly zaklad: string;
  /** články bez data zveřejnění v obsahu — k ručnímu posouzení */
  readonly bezData: { titulek: string; vyskyty: string[] }[] = [];
  private pripraveno: ClanekArchivu[] | null = null;

  constructor(private v: VolbyArchivu) {
    this.zaklad = v.zaklad;
  }

  private async stahni(cas: string, url: string): Promise<string | null> {
    const r = await this.v.stahovac.soubor((this.v.adresaSnimku ?? waybackUrl)(cas, url)).catch(() => null);
    if (!r) {
      this.v.log?.(`nedostupné: ${url} (${cas})`);
      return null;
    }
    return dekodujHtml(r.data, r.typ);
  }

  /** projde stránky, sloučí výskyty, doplní detaily; výsledek seřazený od nejstaršího */
  async priprav(): Promise<ClanekArchivu[]> {
    if (this.pripraveno) return this.pripraveno;
    type Sber = NalezenyClanek & { vyskyty: string[]; vytezovac: Vytezovac; klic: string; cas: string };
    const sber: Sber[] = [];
    for (const s of this.v.stranky) {
      const html = await this.stahni(s.cas, s.url);
      if (!html) continue;
      for (const vt of this.v.vytezovace) {
        for (const c of vt.clanky(html, s.url)) {
          const t = klicTitulku(c.titulek);
          const den = c.datum?.toISOString().slice(0, 10) ?? null;
          const zacatekTextu = klicTitulku(textTagu(c.html).slice(0, 60));
          // stejný článek: stejné id, nebo stejný titulek a (stejné datum, nebo jednomu datum chybí)
          const shoda = sber.find((x) =>
            c.id && x.id
              ? c.id === x.id
              : (x.klic === t &&
                  (!den ||
                    !x.datum ||
                    x.datum.toISOString().slice(0, 10) === den ||
                    (!!c.datumOdvozene && !!x.datumOdvozene))) ||
                // jiná verze téže zprávy (pozvánka → zpráva po akci): stejný den a stejný začátek textu
                (!!den &&
                  x.datum?.toISOString().slice(0, 10) === den &&
                  klicTitulku(textTagu(x.html).slice(0, 60)) === zacatekTextu),
          );
          if (shoda) {
            shoda.vyskyty.push(s.url);
            // odvozené datum: nejdřívější výskyt (zpráva přibyla s první verzí stránky, kde je)
            if (c.datum && (!shoda.datum || (shoda.datumOdvozene && c.datum < shoda.datum))) {
              shoda.datum = c.datum;
              shoda.datumOdvozene = c.datumOdvozene;
            }
            if (textTagu(c.html).length > textTagu(shoda.html).length) shoda.html = c.html;
            shoda.detailUrl ??= c.detailUrl;
          } else sber.push({ ...c, klic: t, vyskyty: [s.url], vytezovac: vt, cas: s.cas });
        }
      }
    }
    const out: ClanekArchivu[] = [];
    for (const c of sber) {
      if (this.v.vynechatText?.test(textTagu(c.html))) continue;
      if (!c.datum) {
        this.bezData.push({ titulek: c.titulek, vyskyty: c.vyskyty });
        continue;
      }
      let html = c.html;
      if (c.detailUrl && c.vytezovac.detail) {
        const d = await this.stahni(c.cas, c.detailUrl);
        const cely = d ? c.vytezovac.detail(d, c.detailUrl) : null;
        if (cely && textTagu(cely).length >= textTagu(html).length) html = cely;
      }
      // adresa článku: detail, jinak stránka + kotva (stabilní mezi snímky → import je idempotentní)
      const url =
        c.detailUrl ??
        `${this.zaklad.replace(/#.*$/, '')}#${c.datum.toISOString().slice(0, 10)}-${slugify(c.titulek, 60)}`;
      if (this.v.vynechat?.includes(url)) continue;
      if (this.v.vynechatText?.test(textTagu(html))) continue;
      out.push({
        url,
        titulek: this.v.titulky?.[url] ?? c.titulek,
        html,
        datum: c.datum,
        kategorie: this.v.kategorie ?? null,
        vyskyty: [...new Set(c.vyskyty)],
        datumOdvozene: c.datumOdvozene ?? null,
      });
    }
    out.sort((a, b) => a.datum.getTime() - b.datum.getTime());
    this.pripraveno = out;
    return out;
  }

  async *stranky(): AsyncIterable<ImportStranka> {
    // archiv starého webu dává jen články; stálé stránky jsou na novém webu napsané znovu
  }

  async *aktuality(od: Date): AsyncIterable<ImportClanek> {
    for (const c of await this.priprav()) if (c.datum >= od) yield c;
  }
}
