// Společný stav jednoho běhu importu (výsledek, mapa starých adres, stažená média) a pomocné operace, které
// sdílejí jednotlivé části importu (sekce/*.ts). Importer (importer.ts) z něj dědí.
import type { Db } from '../../../db/index.js';
import type { SouboroveUloziste } from '../../../lib/soubory.js';
import { DeskaSluzba } from '../../deska/sluzba.js';
import { DotaceSluzba, PresmerovaniSluzba } from '../dalsi.js';
import { ObsahSluzba } from '../obsah.js';
import type { VideaSluzba } from '../videa.js';
import { importujVideo, stahniSoubor } from './media.js';
import { prepisHtml } from './prepis-html.js';
import type { ImportniZdroj, ImportVideo, Stahovac } from './typy.js';

export interface VolbyImportu {
  /** aktuality od tohoto data */
  aktualityOd: Date;
  /** úřední deska od tohoto data (výchozí: vše) */
  deskaOd?: Date;
  stranky?: boolean;
  aktuality?: boolean;
  deska?: boolean;
  menu?: boolean;
  dotace?: boolean;
  /** už importované stránky a aktuality znovu načíst a přepsat obsahem ze zdroje (po vylepšení adaptéru) */
  prepsat?: boolean;
  /** mapování kategorie zdroje → slug kategorie aktualit platformy */
  kategorieAktualit?: Record<string, string>;
  /**
   * Archiv starého webu (např. z Wayback Machine): staré adresy nepatří nové doméně → bez přesměrování,
   * odkazy na neimportované stránky a nedostupné soubory zůstanou jen jako text.
   */
  archiv?: boolean;
  /**
   * Přeskočit aktuality, které už na webu jsou (podobný titulek a datum ±3 dny) — při importu z dalšího zdroje
   * téhož obsahu. `znameClanky` = navíc články z jiného zdroje, které na webu (zatím) nejsou.
   */
  kontrolaDuplicit?: boolean;
  znameClanky?: { titulek: string; datum: Date; zdroj?: string; text?: string }[];
  log?: (zprava: string) => void;
}

export interface Sluzby {
  db: Db;
  /** knihovna videí (když chybí, importér si ji vytvoří) */
  videa?: VideaSluzba;
  obsah: ObsahSluzba;
  soubory: SouboroveUloziste;
  presmerovani: PresmerovaniSluzba;
  dotace: DotaceSluzba;
  deska?: DeskaSluzba;
}

export interface VysledekImportu {
  stranky: number;
  aktuality: number;
  deska: number;
  dotace: number;
  menu: number;
  souboru: number;
  presmerovani: number;
  preskoceno: number;
  /** nově založená videa (z YouTube/Vimea i vlastních souborů v obsahu) */
  videa: number;
  /** aktuality přeskočené jako duplicita: „titulek (datum) = existující“ */
  duplicity: string[];
  chyby: string[];
}

export class ImportKontext {
  media = new Map<string, { url: string; id: string; obrazek: boolean } | null>();
  mapa = new Map<string, string>(); // stará cesta (normalizovaná) → nová
  readonly host: string;
  readonly vysledek: VysledekImportu = {
    stranky: 0,
    aktuality: 0,
    deska: 0,
    dotace: 0,
    menu: 0,
    souboru: 0,
    presmerovani: 0,
    preskoceno: 0,
    videa: 0,
    duplicity: [],
    chyby: [],
  };
  zname: { titulek: string; datum: Date; popis: string; text: string }[] | null = null;

  constructor(
    readonly zdroj: ImportniZdroj,
    readonly s: Sluzby,
    readonly stahovac: Stahovac,
    readonly v: VolbyImportu,
  ) {
    this.host = new URL(zdroj.zaklad).host.replace(/^www\./, '');
  }

  log(z: string) {
    this.v.log?.(z);
  }

  jeNas(u: URL) {
    return u.host.replace(/^www\./, '') === this.host;
  }

  /** je adresa (i relativní) na starém webu obce? Neplatná adresa = ne. */
  jeNasUrl(url: string) {
    try {
      return this.jeNas(new URL(url, this.zdroj.zaklad));
    } catch {
      return false;
    }
  }

  /** chyba jedné položky: zapsat a pokračovat dalšími */
  chyba(co: string, e: unknown) {
    const text = `${co}: ${e instanceof Error ? e.message : String(e)}`;
    this.vysledek.chyby.push(text);
    this.log(`CHYBA ${text}`);
  }

  /**
   * Zápis jedné položky (řádek + přílohy + přesměrování) v jedné transakci: buď celý, nebo vůbec. Služby
   * dostane funkce navázané na transakci. Při chybě se vrátí i mapa adres a počítadla.
   */
  async vTransakci<T>(fn: (s: Sluzby) => Promise<T>): Promise<T> {
    const mapa = new Map(this.mapa);
    const pocty = { ...this.vysledek };
    try {
      const r = await this.s.db.transaction().execute((trx) =>
        fn({
          ...this.s,
          db: trx,
          obsah: new ObsahSluzba(trx),
          presmerovani: new PresmerovaniSluzba(trx),
          dotace: new DotaceSluzba(trx),
          deska: this.s.deska ? new DeskaSluzba(trx) : undefined,
        }),
      );
      return r;
    } catch (e) {
      this.mapa = mapa;
      Object.assign(this.vysledek, {
        ...pocty,
        chyby: this.vysledek.chyby,
        duplicity: this.vysledek.duplicity,
      });
      throw e;
    } finally {
      this.s.obsah.zmena();
      this.s.dotace.zmena();
    }
  }

  cesta(url: string) {
    try {
      const u = new URL(url, this.zdroj.zaklad);
      return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
    } catch {
      return url;
    }
  }

  async uzImportovano(tabulka: 'web_obsah' | 'ud_dokumenty', url: string) {
    const r = await this.s.db
      .selectFrom(tabulka)
      .select('id')
      .where('puvodni_url', '=', url)
      .executeTakeFirst();
    return r?.id ?? null;
  }

  async mapuj(stara: string, nova: string, s: Sluzby = this.s) {
    const vysledek = await s.presmerovani.pridej(this.cesta(stara), nova);
    if (vysledek === 'smycka') {
      this.log(`přesměrování ${this.cesta(stara)} → ${nova} by vytvořilo smyčku — vynecháno`);
      return;
    }
    this.mapa.set(this.cesta(stara).toLowerCase(), nova);
    if (vysledek === 'ulozeno') this.vysledek.presmerovani++;
  }

  // ---------------- média a HTML (implementace v media.ts a prepis-html.ts) ----------------

  /** stáhne soubor ze starého webu a uloží ho (jednou); vrací novou URL */
  soubor(url: string, druh: 'dokument' | 'obrazek' | 'logo' | 'video', alt = '') {
    return stahniSoubor(this, url, druh, alt);
  }

  /** přepíše HTML ze starého webu: média stáhne, vlastní odkazy udělá relativní, vyčistí a sanitizuje */
  prepisHtml(html: string, titulek: string, adresaStranky?: string) {
    return prepisHtml(this, html, titulek, adresaStranky);
  }

  /** video z obsahu starého webu → video v knihovně videí a jeho značka do textu */
  video(v: ImportVideo, titulek: string): Promise<string> {
    return importujVideo(this, v, titulek);
  }
}
