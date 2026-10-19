// Pole obsahu webu a čisté pomůcky (adresy, odvozený slug, rezervované adresy) — sdílí čtení i zápis obsahu.
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { slugify } from '../../lib/slug.js';

export const TYPY: TypObsahu[] = ['stranka', 'aktualita', 'akce', 'odkaz'];
export const MAX_REVIZI = 50;

// adresy, které patří aplikaci — stránka na nejvyšší úrovni se tak jmenovat nesmí
export const REZERVOVANE = new Set([
  'aktuality',
  'akce',
  'galerie',
  'videa',
  'dokumenty',
  'dotace',
  'hledat',
  'uredni-deska',
  'rozpocet',
  'povinne-informace',
  'kontakt',
  'prihlaseni',
  'ucet',
  'sprava',
  'infokanal',
  'oidc',
  'static',
  'soubory',
  'healthz',
  'webhook',
  'api',
  'odhlaseni',
  'prohlaseni-o-pristupnosti',
  'ochrana-osobnich-udaju',
  'sluzby',
  'robots.txt',
  'favicon.ico',
  'sitemap.xml',
  'mapa-stranek',
  'velikost', // volba velikosti písma návštěvníka (/velikost?v=…)
  'manifest.webmanifest',
  'apple-touch-icon.png',
]);

/** pole, která redaktor edituje (a která se ukládají do konceptu a revizí) */
export interface PoleObsahu {
  titulek: string;
  slug: string;
  nadrazena_id: string | null;
  v_menu: boolean;
  odkaz_url: string;
  perex: string;
  obsah_html: string;
  obrazek_id: string | null;
  kategorie_id: number | null;
  datum: string | null; // ISO
  akce_konec: string | null;
  akce_cely_den: boolean;
  akce_misto: string;
}

export const PRAZDNA_POLE: PoleObsahu = {
  titulek: '',
  slug: '',
  nadrazena_id: null,
  v_menu: true,
  odkaz_url: '',
  perex: '',
  obsah_html: '',
  obrazek_id: null,
  kategorie_id: null,
  datum: null,
  akce_konec: null,
  akce_cely_den: false,
  akce_misto: '',
};

export function poleZRadku(o: WebObsah): PoleObsahu {
  return {
    titulek: o.titulek,
    slug: o.slug,
    nadrazena_id: o.nadrazena_id,
    v_menu: o.v_menu,
    odkaz_url: o.odkaz_url,
    perex: o.perex,
    obsah_html: o.obsah_html,
    obrazek_id: o.obrazek_id,
    kategorie_id: o.kategorie_id,
    datum: o.datum ? o.datum.toISOString() : null,
    akce_konec: o.akce_konec ? o.akce_konec.toISOString() : null,
    akce_cely_den: o.akce_cely_den,
    akce_misto: o.akce_misto,
  };
}

/** co se zobrazí v editoru: rozpracovaná verze, jinak zveřejněná */
export function poleProEditor(o: WebObsah): PoleObsahu {
  return o.koncept ? { ...poleZRadku(o), ...(o.koncept as Partial<PoleObsahu>) } : poleZRadku(o);
}

export function doSloupcu(p: PoleObsahu) {
  return {
    titulek: p.titulek,
    slug: p.slug,
    nadrazena_id: p.nadrazena_id,
    v_menu: p.v_menu,
    odkaz_url: p.odkaz_url,
    perex: p.perex,
    obsah_html: p.obsah_html,
    obrazek_id: p.obrazek_id,
    kategorie_id: p.kategorie_id,
    datum: p.datum ? new Date(p.datum) : null,
    akce_konec: p.akce_konec ? new Date(p.akce_konec) : null,
    akce_cely_den: p.akce_cely_den,
    akce_misto: p.akce_misto,
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** slug odvozený z titulku (i s příponou -2, -obec), tj. redaktor ho nezadal ručně */
export function jeOdvozenySlug(slug: string, titulek: string): boolean {
  const z = slugify(titulek);
  if (!z) return false;
  if (slug === z) return true;
  const zbytek = slug.startsWith(`${z}-`) ? slug.slice(z.length + 1) : null;
  return zbytek !== null && /^(obec|obec-\d+|\d+)$/.test(zbytek);
}

/** opakovat při kolizi unikátního indexu (souběžné uložení obsadilo stejnou adresu) */
export function jeKolize(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === '23505';
}

export type AdresaObsahu = Pick<WebObsah, 'typ' | 'slug' | 'nadrazena_id' | 'odkaz_url'>;

/** veřejná adresa obsahu, když už je známá nadřazená stránka */
export function adresaS(o: AdresaObsahu, rodic?: Pick<WebObsah, 'typ' | 'slug'> | null): string {
  if (o.typ === 'aktualita') return `/aktuality/${o.slug}`;
  if (o.typ === 'akce') return `/akce/${o.slug}`;
  if (o.typ === 'odkaz') return o.odkaz_url || '/';
  if (o.nadrazena_id && rodic && rodic.typ === 'stranka') return `/${rodic.slug}/${o.slug}`;
  return `/${o.slug}`;
}

export interface PolozkaMenu {
  id: string;
  titulek: string;
  url: string;
  deti: PolozkaMenu[];
}
