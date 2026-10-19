// Import ze starých webů obcí — společné rozhraní adaptérů.
//
// Adaptér umí přečíst starý web (WordPress přes REST API; Galileo, vismo, Antee… přes HTML) a vrátit obsah
// v neutrální podobě. Všechno ostatní — stažení a přeuložení médií, přepis odkazů, sanitizace HTML, zařazení
// do menu, úřední deska a tabulka přesměrování starých adres — dělá společný Importer (importer.ts, sekce/*.ts).
// Nový adaptér tak implementuje jen čtení: viz docs/IMPORT.md.

/** stránka starého webu (stálý obsah, strom menu) */
export interface ImportStranka {
  /** stabilní klíč ve zdroji (id, nebo URL) — kvůli vazbě na rodiče */
  klic: string;
  /** veřejná adresa na starém webu (pro přesměrování a deduplikaci) */
  url: string;
  titulek: string;
  /** HTML obsahu (odkazy a obrázky mohou být absolutní na starý web) */
  html: string;
  perex?: string;
  rodic?: string | null;
  poradi?: number;
  datum?: Date | null;
}

/** aktualita / článek */
export interface ImportClanek {
  url: string;
  titulek: string;
  html: string;
  perex?: string;
  datum: Date;
  /** neutrální název kategorie (importér ji namapuje na kategorii webu) */
  kategorie?: string | null;
  obrazekUrl?: string | null;
  obrazekAlt?: string | null;
}

/** dokument úřední desky */
export interface ImportDokument {
  url: string;
  nazev: string;
  /** popis (HTML nebo text) — odkazy na soubory se z něj stanou přílohy */
  html: string;
  vyvesenoOd: Date;
  /** null = zdroj datum sejmutí nezná (importér dopočítá podle kategorie) */
  sejmutoDo?: Date | null;
  /** slug kategorie úřední desky platformy (vyhlasky, zastupitelstvo, zamery, rozpocet, jine-urady, verejne-vyhlasky, ostatni) */
  kategorie: string;
  cisloJednaci?: string;
  /** přílohy, které nejsou odkazem v HTML (např. z API) */
  prilohy?: { url: string; nazev?: string }[];
}

/** položka hlavního menu starého webu (max. 2 úrovně se zachovají, hlubší se zploští) */
export interface ImportMenu {
  titulek: string;
  url: string | null;
  deti: ImportMenu[];
}

/** video nalezené v obsahu starého webu (YouTube/Vimeo přehrávač, <video>, [video], [embed]) */
export interface ImportVideo {
  zdroj: 'youtube' | 'vimeo' | 'soubor';
  /** id u služby (YouTube/Vimeo) */
  id?: string;
  /** adresa souboru (MP4/WebM) */
  url?: string;
  /** plakát (<video poster>) */
  plakatUrl?: string;
  /** název, pokud ho zdroj zná (title iframe, popisek figure) */
  nazev?: string;
}

/** dotace / publicita dárců */
export interface ImportDotace {
  projekt: string;
  poskytovatel?: string;
  text?: string;
  odkaz?: string;
  loga: { url: string; alt?: string }[];
}

export interface ImportniZdroj {
  readonly nazev: string;
  /** kořen starého webu, např. https://www.obec.cz (pro rozpoznání vlastních odkazů a médií) */
  readonly zaklad: string;
  stranky(): AsyncIterable<ImportStranka>;
  /** aktuality od data (včetně) */
  aktuality(od: Date): AsyncIterable<ImportClanek>;
  deska?(od?: Date): AsyncIterable<ImportDokument>;
  menu?(): Promise<ImportMenu[]>;
  dotace?(): Promise<ImportDotace[]>;
  /** speciální přesměrování (např. stránky kategorií) — stará cesta → nová */
  presmerovani?(): Promise<Record<string, string>>;
}

/** stahování přes HTTP (zdvořile, s limitem); v testech se podstrčí falešné */
export interface Stahovac {
  text(url: string): Promise<string>;
  json<T = unknown>(url: string): Promise<{ data: T; hlavicky: Headers }>;
  soubor(url: string): Promise<{ data: Buffer; typ: string } | null>;
  /** kolik bajtů souborů se už stáhlo */
  readonly stazeno: number;
}
