// Rychlé dlaždice pod úvodem titulky: vestavěné (deska, aktuality, úřad, infokanál, akce, účet) a vlastní
// (ikona, text, odkaz — i na cizí web). Pořadí a výběr se ukládá ve vzhledu (web_vzhled.rychle_dlazdice);
// bez uložené volby platí výchozí pořadí + `web.rychle_odkazy` z profilu obce (dřívější chování).
import type { ObecProfil } from '../../config/obec.js';
import { jeBezpecnyOdkaz } from '../../lib/navrat.js';

/** vestavěné dlaždice: klíč textu v i18n, ikona, odkaz; `modul` = zobrazit jen se zapnutým modulem obce */
export const VESTAVENE_DLAZDICE = [
  { id: 'deska', klic: 'deska.titulek', ikona: '📋', odkaz: '/uredni-deska', modul: 'deska' },
  { id: 'aktuality', klic: 'web.aktuality', ikona: '📰', odkaz: '/aktuality' },
  { id: 'urad', klic: 'web.obecni_urad', ikona: '🏛️', odkaz: '/kontakt' },
  { id: 'infokanal', klic: 'web.zpravy_do_mobilu', ikona: '📱', odkaz: '/infokanal', modul: 'infokanal' },
  { id: 'akce', klic: 'web.akce', ikona: '📅', odkaz: '/akce' },
  // odkaz se volí podle přihlášení (/ucet nebo /prihlaseni) v šabloně
  { id: 'ucet', klic: 'app.ucet', ikona: '👤', odkaz: '/ucet' },
] as const;
export type IdVestavene = (typeof VESTAVENE_DLAZDICE)[number]['id'];
const IDS = new Set<string>(VESTAVENE_DLAZDICE.map((d) => d.id));

/** nabídka ikon ve správě (lze napsat i jinou) */
export const NABIDKA_IKON = [
  '📚',
  '🏫',
  '⛪',
  '🏥',
  '💊',
  '🚌',
  '🚒',
  '♻️',
  '🗑️',
  '💧',
  '⚡',
  '🌳',
  '⚽',
  '🏊',
  '🎭',
  '🎉',
  '🍽️',
  '🛒',
  '📮',
  '🏠',
  '🅿️',
  '🗺️',
  '📷',
  '🎥',
  '📞',
  '✉️',
  '💳',
  '📝',
  '🔑',
  '❤️',
  '👶',
  '👵',
  '🐕',
  '🔗',
  'ℹ️',
  '⭐',
];

export interface UlozenaDlazdice {
  /** id vestavěné dlaždice, nebo 'vlastni' */
  id: string;
  zobrazit: boolean;
  nazev?: string;
  odkaz?: string;
  ikona?: string;
}

/** dlaždice, jak ji vykreslí titulka i správa */
export interface Dlazdice {
  id: string;
  vlastni: boolean;
  zobrazit: boolean;
  /** vestavěná: klíč i18n; vlastní: text */
  klic?: string;
  nazev?: string;
  ikona: string;
  odkaz: string;
  modul?: string;
  /** odkaz mimo web obce (otevře se v nové kartě) */
  externi: boolean;
}

const jeExterni = (odkaz: string) => /^https?:\/\//i.test(odkaz);

function vestavena(id: string, zobrazit: boolean): Dlazdice {
  const d = VESTAVENE_DLAZDICE.find((x) => x.id === id)!;
  return {
    id: d.id,
    vlastni: false,
    zobrazit,
    klic: d.klic,
    ikona: d.ikona,
    odkaz: d.odkaz,
    modul: 'modul' in d ? d.modul : undefined,
    externi: false,
  };
}

function vlastni(nazev: string, odkaz: string, ikona: string, zobrazit = true): Dlazdice {
  return {
    id: 'vlastni',
    vlastni: true,
    zobrazit,
    nazev,
    ikona: ikona || '🔗',
    odkaz,
    externi: jeExterni(odkaz),
  };
}

/** výsledný seznam (i skrytých — správa je ukazuje vypnuté); vestavěné, které v uložení chybí, se přidají na konec */
export function sestavDlazdice(ulozene: UlozenaDlazdice[] | undefined, obec: ObecProfil): Dlazdice[] {
  if (!ulozene) {
    const vychozi = VESTAVENE_DLAZDICE.map((d) => vestavena(d.id, true));
    const ucet = vychozi.pop()!;
    return [...vychozi, ...obec.web.rychle_odkazy.map((r) => vlastni(r.nazev, r.odkaz, r.ikona)), ucet];
  }
  const vysledek: Dlazdice[] = [];
  const videne = new Set<string>();
  for (const u of ulozene) {
    if (u.id === 'vlastni') {
      if (u.nazev && u.odkaz && jeBezpecnyOdkaz(u.odkaz))
        vysledek.push(vlastni(u.nazev, u.odkaz, u.ikona ?? '', u.zobrazit));
    } else if (IDS.has(u.id) && !videne.has(u.id)) {
      videne.add(u.id);
      vysledek.push(vestavena(u.id, u.zobrazit));
    }
  }
  for (const d of VESTAVENE_DLAZDICE) if (!videne.has(d.id)) vysledek.push(vestavena(d.id, false));
  return vysledek;
}

/** kolik prázdných řádků pro nové vlastní dlaždice nabídnout ve správě */
export const NOVYCH_RADKU = 3;
export const MAX_DLAZDIC = 16;

export type ChybaDlazdic = { chyba: string };

/**
 * Z formuláře: řádky `dl_id_<i>`, `dl_zobrazit_<i>`, `dl_poradi_<i>`, u vlastních `dl_ikona_<i>`, `dl_nazev_<i>`,
 * `dl_odkaz_<i>`, `dl_odebrat_<i>`. Vlastní řádek bez textu i odkazu se přeskočí (prázdný nový / smazaný).
 */
export function dlazdiceZFormulare(
  b: Record<string, unknown>,
  jeden: (x: unknown) => string,
): UlozenaDlazdice[] | ChybaDlazdic {
  const radky: { poradi: number; i: number; d: UlozenaDlazdice }[] = [];
  for (let i = 0; i < 100; i++) {
    const id = jeden(b[`dl_id_${i}`]);
    if (!id) continue;
    const zobrazit = jeden(b[`dl_zobrazit_${i}`]) === 'ano';
    const poradiText = jeden(b[`dl_poradi_${i}`]).trim();
    const poradi = poradiText && Number.isFinite(Number(poradiText)) ? Number(poradiText) : 1000 + i;
    if (id === 'vlastni') {
      if (jeden(b[`dl_odebrat_${i}`]) === 'ano') continue;
      const nazev = jeden(b[`dl_nazev_${i}`]).replace(/\s+/g, ' ').trim().slice(0, 40);
      const odkaz = jeden(b[`dl_odkaz_${i}`]).trim().slice(0, 500);
      const ikona = [...jeden(b[`dl_ikona_${i}`]).trim()].slice(0, 4).join('');
      if (!nazev && !odkaz) continue;
      if (!nazev) return { chyba: `Dlaždice s odkazem ${odkaz}: doplňte text.` };
      // odkaz bez schématu jako „www.obec.cz“ → https://
      const plny = /^www\./i.test(odkaz) ? `https://${odkaz}` : odkaz;
      if (!plny || !jeBezpecnyOdkaz(plny))
        return {
          chyba: `Dlaždice „${nazev}“: odkaz musí začínat lomítkem (stránka webu, např. /sluzby-obec/obecni-knihovna) nebo https://.`,
        };
      radky.push({ poradi, i, d: { id, zobrazit, nazev, odkaz: plny, ikona: ikona || '🔗' } });
    } else if (IDS.has(id)) radky.push({ poradi, i, d: { id, zobrazit } });
  }
  if (radky.filter((r) => r.d.id === 'vlastni').length > MAX_DLAZDIC)
    return { chyba: `Vlastních dlaždic může být nejvýš ${MAX_DLAZDIC}.` };
  return radky.sort((a, b2) => a.poradi - b2.poradi || a.i - b2.i).map((r) => r.d);
}
