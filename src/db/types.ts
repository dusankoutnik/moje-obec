// Typy tabulek pro Kysely — ručně psané, aby seděly 1:1 s SQL migracemi (žádný codegen, žádná magie).
import type { ColumnType, Generated, Insertable, Selectable, Updateable, JSONColumnType } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
// Generated<ColumnType<…>> Kysely neumí (nerozbalí vnořený ColumnType) — proto zvláštní typ pro sloupce s DEFAULT now()
type TimestampGenerated = ColumnType<Date, Date | string | undefined, Date | string>;
type TimestampNullable = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

// web = obsah webu · deska = úřední deska a rozpočet · redaktor = hlášení infokanálu (jako v MůjÚčtu)
// vstupne = kontrola vstupenek (připraveno) · kviz = správa kvízu · spravce = vše obsahové + vzhled a účty · admin = vše
export type Role = 'web' | 'deska' | 'redaktor' | 'kviz' | 'ucetni' | 'vstupne' | 'spravce' | 'admin';
export const ROLE: readonly Role[] = [
  'web',
  'deska',
  'redaktor',
  'kviz',
  'ucetni',
  'vstupne',
  'spravce',
  'admin',
] as const;

export interface UzivateleTable {
  id: Generated<string>;
  telefon: string;
  email: string | null;
  heslo_hash: string | null;
  jmeno: Generated<string>;
  prijmeni: Generated<string>;
  prezdivka: Generated<string>;
  cast_obce: Generated<string>;
  role: Generated<Role[]>;
  rezident: Generated<boolean>;
  gdpr_souhlas_at: TimestampNullable;
  telefon_overen_at: TimestampNullable;
  email_overen_at: TimestampNullable;
  blokovan_at: TimestampNullable;
  email_cekajici: Generated<string | null>;
  email_cekajici_at: TimestampNullable;
  vytvoren_at: TimestampGenerated;
  upraven_at: TimestampGenerated;
}
export type Uzivatel = Selectable<UzivateleTable>;
export type NovyUzivatel = Insertable<UzivateleTable>;
export type UpravaUzivatele = Updateable<UzivateleTable>;

// zmena = čerstvé ověření před citlivou změnou účtu (SMS na telefon účtu); email = potvrzení nového e-mailu
export type OtpUcel = 'prihlaseni' | 'odber' | 'registrace' | 'zmena' | 'email';
export interface OtpKodyTable {
  id: Generated<number>;
  kontakt: string;
  ucel: string;
  kod_hash: string;
  expires_at: Timestamp;
  pouzit_at: TimestampNullable;
  pokusy: Generated<number>;
  vytvoren_at: TimestampGenerated;
}

export interface AuditLogTable {
  id: Generated<number>;
  ts: TimestampGenerated;
  uzivatel_id: string | null;
  akce: string;
  detail: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  ip: string | null;
}

export interface SezeniTable {
  sid: string;
  data: JSONColumnType<Record<string, unknown>>;
  expires_at: Timestamp;
}

export interface OidcPayloadsTable {
  id: string;
  typ: string;
  payload: JSONColumnType<Record<string, unknown>>;
  grant_id: string | null;
  user_code: string | null;
  uid: string | null;
  expires_at: TimestampNullable;
  consumed_at: TimestampNullable;
}

export interface OidcKlientiTable {
  client_id: string;
  client_secret: string;
  nazev: string;
  redirect_uris: string[];
  post_logout_redirect_uris: Generated<string[]>;
  duveryhodny: Generated<boolean>;
  aktivni: Generated<boolean>;
  vytvoren_at: TimestampGenerated;
}

export interface NastaveniTable {
  klic: string;
  hodnota: JSONColumnType<Record<string, unknown>>;
  upraven_at: TimestampGenerated;
}

// ---- infokanál ----
export interface IkKategorieTable {
  id: Generated<number>;
  slug: string;
  nazev: string;
  povinna: Generated<boolean>;
  poradi: Generated<number>;
}

export type KanalPreference = 'sms' | 'email' | 'smisene';
export interface IkOdberateleTable {
  id: Generated<string>;
  jmeno: Generated<string>;
  telefon: string | null;
  email: string | null;
  cast_obce: Generated<string>;
  kanal: Generated<KanalPreference>;
  token: string;
  overen_at: TimestampNullable;
  odhlasen_at: TimestampNullable;
  zdroj: Generated<string>;
  souhlas_at: TimestampNullable;
  uzivatel_id: string | null;
  poznamka: Generated<string>;
  vytvoren_at: TimestampGenerated;
}
export type Odberatel = Selectable<IkOdberateleTable>;

export interface IkOptoutyTable {
  odberatel_id: string;
  kategorie_id: number;
}

export type StavHlaseni = 'naplanovano' | 'odesila_se' | 'hotovo' | 'zruseno';
export interface IkHlaseniTable {
  id: Generated<string>;
  autor_id: string | null;
  kategorie_id: number;
  krizove: Generated<boolean>;
  cil: Generated<string>;
  cil_detail: JSONColumnType<string[]>;
  sms_text: string | null;
  email_predmet: string | null;
  email_text: string | null;
  email_html: string | null;
  clanek_titulek: string | null;
  clanek_html: string | null;
  stav: Generated<StavHlaseni>;
  naplanovano_na: TimestampNullable;
  zdroj_automatu: string | null;
  vytvoreno_at: TimestampGenerated;
  dokonceno_at: TimestampNullable;
}
export type Hlaseni = Selectable<IkHlaseniTable>;

// odesila_se = řádek si zabral rozesílací worker (atomicky), odeslání právě probíhá
export type StavPrijemce = 'ceka' | 'odesila_se' | 'odeslano' | 'doruceno' | 'selhalo' | 'vzdano';
export interface IkPrijemciTable {
  id: Generated<number>;
  hlaseni_id: string;
  odberatel_id: string | null;
  kanal: 'sms' | 'email';
  kontakt: string;
  stav: Generated<StavPrijemce>;
  brana_id: string | null;
  pokusy: Generated<number>;
  posledni_chyba: string | null;
  odeslano_at: TimestampNullable;
  doruceno_at: TimestampNullable;
  /** kdy si řádek zabral worker (stav odesila_se) — podle toho se hledají zaseknuté */
  zabrano_at: TimestampNullable;
  /** dočasná chyba: další pokus nejdřív v tento čas */
  dalsi_pokus_at: TimestampNullable;
}

// ---- soubory ----
export type DruhSouboru = 'dokument' | 'obrazek' | 'logo' | 'video' | 'titulky';
export interface SouboryTable {
  id: Generated<string>;
  druh: DruhSouboru;
  puvodni_nazev: string;
  mime: string;
  pripona: string;
  velikost: number;
  sirka: number | null;
  vyska: number | null;
  alt: Generated<string>;
  sha256: string;
  zdroj_url: string | null;
  nahral_id: string | null;
  vytvoren_at: TimestampGenerated;
}
export type Soubor = Selectable<SouboryTable>;

// ---- úřední deska ----
export interface UdKategorieTable {
  id: Generated<number>;
  slug: string;
  nazev: string;
  min_dni: Generated<number>;
  vychozi_dni: Generated<number>;
  rozpocet: Generated<boolean>;
  poradi: Generated<number>;
  aktivni: Generated<boolean>;
  /** sejmuté dokumenty kategorie jsou ve veřejném archivu (false = jen ve správě; dokumenty jiných úřadů) */
  archiv_verejny: Generated<boolean>;
}
export type UdKategorie = Selectable<UdKategorieTable>;

export interface UdDokumentyTable {
  id: Generated<string>;
  nazev: string;
  kategorie_id: number;
  cislo_jednaci: Generated<string>;
  puvodce: Generated<string>;
  popis: Generated<string>;
  vyveseno_od: Timestamp;
  sejmuto_do: TimestampNullable;
  sejmuti_duvod: Generated<string>;
  typ_rozpoctu: string | null;
  rok: number | null;
  hlaseni_id: string | null;
  autor_id: string | null;
  puvodni_url: string | null;
  vytvoreno_at: TimestampGenerated;
  upraveno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
  /** rozpočtová dokumentace: dokument, který tento sejmul jako nahrazený (vratné) */
  nahrazeno_id: string | null;
  /** stav před nahrazením — pro obnovu, když nahrazující dokument zmizí nebo se změní */
  pred_nahrazenim_do: TimestampNullable;
  pred_nahrazenim_duvod: string | null;
}
export type UdDokument = Selectable<UdDokumentyTable>;

export interface UdPrilohyTable {
  dokument_id: string;
  soubor_id: string;
  poradi: Generated<number>;
}

export interface PiBodyTable {
  klic: string;
  obsah_html: Generated<string>;
  upraveno_at: TimestampGenerated;
  upravil_id: string | null;
}

// ---- obecní web ----
export type TypObsahu = 'stranka' | 'aktualita' | 'akce' | 'odkaz';
export interface WebKategorieTable {
  id: Generated<number>;
  slug: string;
  nazev: string;
  poradi: Generated<number>;
}
export interface WebObsahTable {
  id: Generated<string>;
  typ: TypObsahu;
  titulek: Generated<string>;
  slug: string;
  nadrazena_id: string | null;
  poradi: Generated<number>;
  v_menu: Generated<boolean>;
  odkaz_url: Generated<string>;
  perex: Generated<string>;
  obsah_html: Generated<string>;
  obrazek_id: string | null;
  kategorie_id: number | null;
  datum: TimestampNullable;
  akce_konec: TimestampNullable;
  akce_cely_den: Generated<boolean>;
  akce_misto: Generated<string>;
  stav: Generated<'koncept' | 'zverejneno'>;
  koncept: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  koncept_at: TimestampNullable;
  zverejneno_at: TimestampNullable;
  autor_id: string | null;
  upravil_id: string | null;
  zdroj: Generated<string>;
  puvodni_url: string | null;
  hlaseni_id: string | null;
  vytvoreno_at: TimestampGenerated;
  upraveno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
}
export type WebObsah = Selectable<WebObsahTable>;
export interface WebRevizeTable {
  id: Generated<number>;
  obsah_id: string;
  data: JSONColumnType<Record<string, unknown>>;
  duvod: string;
  autor_id: string | null;
  vytvoreno_at: TimestampGenerated;
}
export interface WebGalerieTable {
  id: Generated<string>;
  nazev: string;
  slug: string;
  popis: Generated<string>;
  datum: ColumnType<string | null, string | null | undefined, string | null>;
  stav: Generated<'koncept' | 'zverejneno'>;
  autor_id: string | null;
  puvodni_url: string | null;
  vytvoreno_at: TimestampGenerated;
  upraveno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
}
export interface WebGalerieFotkyTable {
  galerie_id: string;
  soubor_id: string;
  poradi: Generated<number>;
  popisek: Generated<string>;
}
export interface WebDokumentyTable {
  id: Generated<string>;
  nazev: string;
  popis: Generated<string>;
  skupina: Generated<string>;
  soubor_id: string;
  poradi: Generated<number>;
  autor_id: string | null;
  vytvoreno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
}
export interface WebDotaceTable {
  id: Generated<string>;
  projekt: string;
  poskytovatel: Generated<string>;
  text: Generated<string>;
  odkaz: Generated<string>;
  zobrazit_od: ColumnType<string, string | undefined, string>;
  zobrazit_do: ColumnType<string | null, string | null | undefined, string | null>;
  v_paticce: Generated<boolean>;
  poradi: Generated<number>;
  stav: Generated<'koncept' | 'hotovo'>;
  upozorneno_at: TimestampNullable;
  autor_id: string | null;
  puvodni_url: string | null;
  vytvoreno_at: TimestampGenerated;
  upraveno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
}
export interface WebDotaceLogaTable {
  dotace_id: string;
  soubor_id: string;
  poradi: Generated<number>;
}
export interface WebVideaTable {
  id: Generated<string>;
  nazev: string;
  popis: Generated<string>;
  prepis: Generated<string>;
  zdroj: 'soubor' | 'youtube' | 'vimeo';
  externi_id: Generated<string>;
  soubor_id: string | null;
  plakat_id: string | null;
  titulky_id: string | null;
  poradi: Generated<number>;
  na_titulce: Generated<boolean>;
  stav: Generated<'koncept' | 'zverejneno'>;
  autor_id: string | null;
  puvodni_url: string | null;
  vytvoreno_at: TimestampGenerated;
  upraveno_at: TimestampGenerated;
  smazano_at: TimestampNullable;
}
export type WebVideo = Selectable<WebVideaTable>;
export interface WebPresmerovaniTable {
  stara_cesta: string;
  nova_cesta: string;
  pocet: Generated<number>;
  posledni_at: TimestampNullable;
  vytvoreno_at: TimestampGenerated;
}

// zámek přihlášení heslem — klíč „email:<adresa>“ nebo „ucet:<id>“
export interface PrihlaseniZamkyTable {
  klic: string;
  chyby: Generated<number>;
  posledni_chyba_at: TimestampGenerated;
  zamceno_do: TimestampNullable;
}

export interface KvizKategorieTable {
  id: Generated<number>;
  slug: string;
  nazev: string;
  ikona: Generated<string>;
  poradi: Generated<number>;
  aktualizovano_at: TimestampGenerated;
}

export interface KvizOtazkyTable {
  id: string;
  kategorie_id: number;
  otazka: string;
  odpovedi: string[];
  obtiznost: number;
  vysvetleni: Generated<string>;
  zdroj: Generated<string>;
  balik: Generated<string>;
  v_baliku: Generated<boolean>;
  /** přidaná ručně ve správě — import YAML ji nevyřadí ani nepřepíše */
  rucne: Generated<boolean>;
  vypnuta_at: TimestampNullable;
  vytvoreno_at: TimestampGenerated;
  aktualizovano_at: TimestampGenerated;
}

export interface KvizHraciTable {
  id: Generated<string>;
  /** krátké pořadové číslo (jen pro statistiky správy) */
  cislo: Generated<number>;
  uzivatel_id: string | null;
  reset_at: TimestampNullable;
  kategorie: Generated<string[]>;
  otazka_id: string | null;
  poradi: number[] | null;
  odpoved_id: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  kolo: Generated<number>;
  kolo_od: TimestampGenerated;
  krok: Generated<number>;
  kolo_spravne: Generated<number>;
  posun: Generated<number>;
  vytvoren_at: TimestampGenerated;
  posledni_at: TimestampGenerated;
}

export interface KvizOdpovediTable {
  id: Generated<string>;
  hrac_id: string;
  otazka_id: string;
  zvolena: number;
  spravne: boolean;
  ts: TimestampGenerated;
}

export interface Database {
  kviz_kategorie: KvizKategorieTable;
  kviz_otazky: KvizOtazkyTable;
  kviz_hraci: KvizHraciTable;
  kviz_odpovedi: KvizOdpovediTable;
  prihlaseni_zamky: PrihlaseniZamkyTable;
  web_kategorie: WebKategorieTable;
  web_obsah: WebObsahTable;
  web_revize: WebRevizeTable;
  web_galerie: WebGalerieTable;
  web_galerie_fotky: WebGalerieFotkyTable;
  web_dokumenty: WebDokumentyTable;
  web_dotace: WebDotaceTable;
  web_dotace_loga: WebDotaceLogaTable;
  web_presmerovani: WebPresmerovaniTable;
  web_videa: WebVideaTable;
  soubory: SouboryTable;
  ud_kategorie: UdKategorieTable;
  ud_dokumenty: UdDokumentyTable;
  ud_prilohy: UdPrilohyTable;
  pi_body: PiBodyTable;
  uzivatele: UzivateleTable;
  otp_kody: OtpKodyTable;
  audit_log: AuditLogTable;
  sezeni: SezeniTable;
  oidc_payloads: OidcPayloadsTable;
  oidc_klienti: OidcKlientiTable;
  nastaveni: NastaveniTable;
  ik_kategorie: IkKategorieTable;
  ik_odberatele: IkOdberateleTable;
  ik_optouty: IkOptoutyTable;
  ik_hlaseni: IkHlaseniTable;
  ik_prijemci: IkPrijemciTable;
}
