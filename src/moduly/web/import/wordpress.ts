// Adaptér WordPress: čte veřejné REST API (/wp-json/wp/v2) — stránky, příspěvky, kategorie; menu z HTML titulky
// (REST menu bez přihlášení nevydá). Úřední deska = příspěvky ve zvolené kategorii (výchozí slug „uredni-deska“).
// Pilot pro Vlastibořice; u obcí převažují proprietární CMS (Galileo, vismo…), viz docs/IMPORT.md.
import { odhadniRozpocet } from './pomucky.js';
import { dekodujEntity, parsujMenu } from './html-pomoc.js';
import type {
  ImportClanek,
  ImportDokument,
  ImportDotace,
  ImportMenu,
  ImportniZdroj,
  ImportRubrika,
  ImportStranka,
  Stahovac,
} from './typy.js';

interface WpPolozka {
  id: number;
  link: string;
  date: string;
  date_gmt?: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt?: { rendered: string };
  parent?: number;
  menu_order?: number;
  categories?: number[];
  featured_media?: number;
  _embedded?: { 'wp:featuredmedia'?: { source_url?: string; alt_text?: string }[] };
}
interface WpKategorie {
  id: number;
  slug: string;
  name: string;
  parent: number;
  link: string;
  count?: number;
}

export interface VolbyWordpress {
  zaklad: string;
  /**
   * původní adresa webu, když se čte z jeho kopie (např. archivu na jiné doméně): odkazy, média i původní
   * adresy článků se přepíšou na ni, takže sedí přesměrování i už importovaný obsah
   */
  puvodni?: string;
  stahovac: Stahovac;
  /** slug kategorie příspěvků, které tvoří úřední desku */
  kategorieDesky?: string;
  /** dotace k založení (WordPress je nemá strukturovaně — u pilotu z patičky webu) */
  dotace?: ImportDotace[];
  /** třída <ul> s hlavním menu (regulární výraz) */
  menuTrida?: RegExp;
}

export class WordpressZdroj implements ImportniZdroj {
  readonly nazev = 'WordPress';
  readonly zaklad: string;
  private api: string;
  private kat: WpKategorie[] | null = null;

  private cteni: string;

  constructor(private v: VolbyWordpress) {
    this.cteni = v.zaklad.replace(/\/$/, '');
    this.zaklad = (v.puvodni ?? v.zaklad).replace(/\/$/, '');
    this.api = `${this.cteni}/wp-json/wp/v2`;
  }

  /** položka z kopie webu → jako z původního webu (všechny adresy kopie přepsat na původní) */
  private puvodni<T>(x: T): T {
    if (this.cteni === this.zaklad) return x;
    const kopie = new URL(this.cteni).host;
    const cil = new URL(this.zaklad);
    const vzor = new RegExp(`https?://${kopie.replace(/[.]/g, '\\.')}`, 'g');
    return JSON.parse(JSON.stringify(x).replace(vzor, cil.origin)) as T;
  }

  private async *strankovane<T>(cesta: string): AsyncIterable<T> {
    for (let strana = 1; strana < 1000; strana++) {
      const oddel = cesta.includes('?') ? '&' : '?';
      const { data, hlavicky } = await this.v.stahovac.json<T[]>(
        `${this.api}/${cesta}${oddel}per_page=100&page=${strana}`,
      );
      for (const x of data) yield this.puvodni(x);
      const celkem = Number(hlavicky.get('x-wp-totalpages') ?? '1');
      if (strana >= celkem || !data.length) return;
    }
  }

  async kategorie(): Promise<WpKategorie[]> {
    if (!this.kat) {
      this.kat = [];
      for await (const k of this.strankovane<WpKategorie>(
        'categories?_fields=id,slug,name,parent,link,count',
      ))
        this.kat.push(k);
    }
    return this.kat;
  }

  private async idDesky(): Promise<number | null> {
    const slug = this.v.kategorieDesky ?? 'uredni-deska';
    return (await this.kategorie()).find((k) => k.slug === slug)?.id ?? null;
  }

  async *stranky(): AsyncIterable<ImportStranka> {
    for await (const p of this.strankovane<WpPolozka>(
      'pages?status=publish&_fields=id,link,date,title,content,excerpt,parent,menu_order&orderby=menu_order&order=asc',
    )) {
      yield {
        klic: String(p.id),
        url: p.link,
        titulek: dekodujEntity(p.title.rendered).trim() || 'Bez názvu',
        html: p.content.rendered,
        rodic: p.parent ? String(p.parent) : null,
        poradi: p.menu_order ?? 0,
        datum: new Date(p.date),
      };
    }
  }

  async *aktuality(od: Date): AsyncIterable<ImportClanek> {
    const deska = await this.idDesky();
    const kat = await this.kategorie();
    const vyjmout = deska ? `&categories_exclude=${deska}` : '';
    for await (const p of this.strankovane<WpPolozka>(
      `posts?status=publish&after=${od.toISOString()}${vyjmout}&_embed=wp:featuredmedia&orderby=date&order=asc`,
    )) {
      const slugy = (p.categories ?? [])
        .map((id) => kat.find((k) => k.id === id)?.slug)
        .filter(Boolean) as string[];
      const media = p._embedded?.['wp:featuredmedia']?.[0];
      yield {
        url: p.link,
        titulek: dekodujEntity(p.title.rendered).trim() || 'Bez názvu',
        html: p.content.rendered,
        perex: dekodujEntity((p.excerpt?.rendered ?? '').replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ')
          .replace(/\[…\]|\[&hellip;\]/g, '…')
          .trim(),
        datum: new Date(p.date_gmt ? p.date_gmt + 'Z' : p.date),
        kategorie: slugy[0] ?? null,
        kategorieVse: this.odNejkonkretnejsi(p.categories ?? [], kat),
        obrazekUrl: media?.source_url ?? null,
        obrazekAlt: media?.alt_text ?? null,
      };
    }
  }

  async *deska(od?: Date): AsyncIterable<ImportDokument> {
    const deska = await this.idDesky();
    if (!deska) return;
    const kat = await this.kategorie();
    const after = od ? `&after=${od.toISOString()}` : '';
    for await (const p of this.strankovane<WpPolozka>(
      `posts?status=publish&categories=${deska}${after}&_fields=id,link,date,date_gmt,title,content,categories&orderby=date&order=asc`,
    )) {
      const nazev = dekodujEntity(p.title.rendered).trim() || 'Dokument';
      const slugy = (p.categories ?? [])
        .filter((id) => id !== deska)
        .map((id) => kat.find((k) => k.id === id)?.slug ?? '');
      yield {
        url: p.link,
        nazev,
        html: p.content.rendered,
        vyvesenoOd: new Date(p.date_gmt ? p.date_gmt + 'Z' : p.date),
        sejmutoDo: null,
        kategorie: kategorieDesky(nazev, slugy),
      };
    }
  }

  async menu(): Promise<ImportMenu[]> {
    const html = this.puvodni(await this.v.stahovac.text(this.cteni + '/'));
    return parsujMenu(html, this.v.menuTrida, this.zaklad);
  }

  async dotace(): Promise<ImportDotace[]> {
    return this.v.dotace ?? [];
  }

  /** slugy rubrik příspěvku: nejhlubší (nejkonkrétnější) první, jinak v pořadí zdroje */
  private odNejkonkretnejsi(ids: number[], kat: WpKategorie[]): string[] {
    const hloubka = (id: number) => {
      let n = 0;
      for (let k = kat.find((x) => x.id === id); k && k.parent && n < 20; n++)
        k = kat.find((x) => x.id === k!.parent);
      return n;
    };
    return ids
      .map((id, i) => ({ id, i, h: hloubka(id) }))
      .sort((a, b) => b.h - a.h || a.i - b.i)
      .map((x) => kat.find((k) => k.id === x.id)?.slug)
      .filter((s): s is string => !!s);
  }

  /** rubriky aktualit: bez rubrik úřední desky a bez prázdných větví */
  async rubriky(): Promise<ImportRubrika[]> {
    const deska = await this.idDesky();
    const kat = await this.kategorie();
    const vDesce = (k: WpKategorie) => {
      for (let x: WpKategorie | undefined = k, n = 0; x && n < 20; n++) {
        if (x.id === deska) return true;
        x = x.parent ? kat.find((y) => y.id === x!.parent) : undefined;
      }
      return false;
    };
    const neprazdna = new Set<number>();
    for (const k of kat)
      if ((k.count ?? 1) > 0)
        for (let x: WpKategorie | undefined = k, n = 0; x && n < 20; n++) {
          neprazdna.add(x.id);
          x = x.parent ? kat.find((y) => y.id === x!.parent) : undefined;
        }
    return kat
      .filter((k) => !vDesce(k) && neprazdna.has(k.id))
      .map((k) => ({
        slug: k.slug,
        nazev: dekodujEntity(k.name),
        rodic: k.parent ? (kat.find((x) => x.id === k.parent)?.slug ?? null) : null,
        url: k.link,
      }));
  }

  /** stránky kategorií a archivy: kategorie desky → úřední deska, ostatní → aktuality */
  async presmerovani(): Promise<Record<string, string>> {
    const deska = await this.idDesky();
    const out: Record<string, string> = {};
    for (const k of await this.kategorie()) {
      out[k.link] = k.id === deska || k.parent === deska ? '/uredni-deska' : '/aktuality';
    }
    return out;
  }
}

/** dokumenty jiných úřadů s osobními údaji (exekuce, dražby, insolvence, soudy) — mají přednost před „usnesením“ */
const CIZI_OSOBNI =
  /exekut|exekuc|drazb|drazeb|insolven|\bsoud|notar|dedick|\d+\s*ex\s*\d|opatrovn|pozustalost|nezn\w* (vlastnik|pobyt|adres)|doruceni.*(pisemnost|verejnou vyhlaskou)|vyzva .*(vlastnik|dedic)/;
const JINE_URADY =
  /krajsk\w* urad|mestsk\w* urad|\bmeu\b|\bku\b|financni urad|celni urad|katastr|uzemni pracoviste|mikroregion|\bdso\b|\bcez\b|scvk|povodi|hasicsk\w* zachrann|ministerstv|\bvlad[ay]\b|hygien|policie|urad prace|cssz|zdravotni pojistovn|statni pozemkov|lesy cr|rsd\b|reditelstvi silnic|agentura|inspekce|stavebni urad|odbor (zivotniho|dopravy|vystavby|stavebni)/;

/** zařazení dokumentu úřední desky podle názvu a kategorií zdroje (obecné heuristiky pro české obce) */
export function kategorieDesky(nazev: string, slugy: string[]): string {
  const n = nazev.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const s = slugy.join(' ');
  if (/rozpoc|financ|hospodar|vyhled/.test(s) || odhadniRozpocet(nazev, new Date())) {
    if (odhadniRozpocet(nazev, new Date())) return 'rozpocet';
  }
  // exekuce, dražby, soudy: vždy jiný úřad — i když je v názvu „usnesení“ nebo „veřejná vyhláška“
  if (CIZI_OSOBNI.test(n)) return 'jine-urady';
  if (/verejna vyhlaska/.test(n)) return JINE_URADY.test(n) ? 'jine-urady' : 'verejne-vyhlasky';
  if (/zamer|zamyslu?/.test(n) && !/zamer\w* uzemn/.test(n)) return 'zamery';
  if (/pravnich-predpisu|vyhlask/.test(s) || /obecne zavazn|\bozv\b|narizeni obce/.test(n)) return 'vyhlasky';
  if (JINE_URADY.test(n)) return 'jine-urady';
  if (
    /pozvank|informace o (konani|zasedani)|oznameni o (konani|zasedani)/.test(n) &&
    /zastupitel|zasedani|\bzo\b/.test(n) &&
    !/zapis|usneseni/.test(n) // „Zápis … a pozvánka na další zasedání“ zůstává u zápisů
  )
    return 'pozvanky-zo';
  if (/zastupitel/.test(s) || /zapis|usneseni|zasedani|zastupitelstv|\bzo\b/.test(n)) return 'zastupitelstvo';
  return 'ostatni';
}
