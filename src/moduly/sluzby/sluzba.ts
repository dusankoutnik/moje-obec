// Moduly obce zapínatelné ve správě (Správa → Moduly obce): rezervace, předprodej, spolujízda, eKnihy, infokanál, kvíz.
// Výchozí stav je z obec.yml (`moduly`), změny ze správy se ukládají do nastaveni.moduly. Platformní moduly (infokanál,
// kvíz) se registrují při startu podle obec.yml; vypnutí za běhu je jen skryje (guard v index.ts) — bez restartu.
// Aplikace za proxy (rezervace, eKnihy) jsou dostupné, jen když je nastavená jejich vnitřní adresa v env.
import type { Env } from '../../config/env.js';
import type { ObecProfil } from '../../config/obec.js';
import type { Db } from '../../db/index.js';
import { zapisAudit } from '../../lib/audit.js';

export const KLICE_MODULU = ['rezervace', 'predprodej', 'spolujizda', 'eknihy', 'infokanal', 'kviz'] as const;
export type KlicModulu = (typeof KLICE_MODULU)[number];
export type StavModulu = Record<KlicModulu, boolean>;

export interface PopisModulu {
  klic: KlicModulu;
  /** veřejná adresa (relativní k doméně) */
  url: string;
  /** cesty, které modul na webu zabírá (prefixy) */
  cesty: string[];
  /** podčást jiného modulu (předprodej, spolujízda = části rezervací) */
  rodic?: KlicModulu;
  /** platformní modul (registrovaný v aplikaci) nebo aplikace za proxy */
  druh: 'platforma' | 'aplikace';
}

export const MODULY: readonly PopisModulu[] = [
  { klic: 'rezervace', url: '/rezervace/', cesty: ['/rezervace'], druh: 'aplikace' },
  {
    klic: 'predprodej',
    url: '/rezervace/predprodej',
    cesty: ['/rezervace/predprodej'],
    rodic: 'rezervace',
    druh: 'aplikace',
  },
  {
    klic: 'spolujizda',
    url: '/rezervace/spolujizda',
    cesty: ['/rezervace/spolujizda'],
    rodic: 'rezervace',
    druh: 'aplikace',
  },
  { klic: 'infokanal', url: '/infokanal', cesty: ['/infokanal'], druh: 'platforma' },
  { klic: 'eknihy', url: '/eknihy/', cesty: ['/eknihy'], druh: 'aplikace' },
  { klic: 'kviz', url: '/kviz', cesty: ['/kviz'], druh: 'platforma' },
];

/** leží cesta pod prefixem? (/kviz, /kviz/…, /kviz?… — ne /kvizy) */
export function podCestou(cesta: string, prefix: string): boolean {
  if (!cesta.startsWith(prefix)) return false;
  const dalsi = cesta.charAt(prefix.length);
  return dalsi === '' || dalsi === '/' || dalsi === '?' || dalsi === '#';
}

const KLIC_NASTAVENI = 'moduly';
const KES_MS = 30_000;

export class ModulySluzba {
  private kes: { at: number; ulozene: Partial<StavModulu> } | null = null;

  constructor(
    private db: Db,
    private obec: ObecProfil,
    private env: Pick<Env, 'APLIKACE_REZERVACE_URL' | 'APLIKACE_EKNIHY_URL'>,
  ) {}

  popis(klic: KlicModulu): PopisModulu {
    return MODULY.find((m) => m.klic === klic)!;
  }

  /** dá se modul na této instalaci vůbec zapnout? (aplikace = nastavená adresa; platformní = povolený v obec.yml) */
  dostupny(klic: KlicModulu): boolean {
    switch (klic) {
      case 'rezervace':
      case 'predprodej':
      case 'spolujizda':
        return !!this.env.APLIKACE_REZERVACE_URL;
      case 'eknihy':
        return !!this.env.APLIKACE_EKNIHY_URL;
      case 'infokanal':
        return this.obec.moduly.infokanal;
      case 'kviz':
        return this.obec.moduly.kviz;
    }
  }

  /** výchozí stav z obec.yml */
  vychozi(klic: KlicModulu): boolean {
    const m = this.obec.moduly;
    if (klic === 'eknihy') return m.eknihy || m.knihovna;
    return m[klic];
  }

  private async ulozene(): Promise<Partial<StavModulu>> {
    if (this.kes && Date.now() - this.kes.at < KES_MS) return this.kes.ulozene;
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirst();
    const ulozene: Partial<StavModulu> = {};
    const h = (r?.hodnota ?? {}) as Record<string, unknown>;
    for (const k of KLICE_MODULU) if (typeof h[k] === 'boolean') ulozene[k] = h[k];
    this.kes = { at: Date.now(), ulozene };
    return ulozene;
  }

  /** zahodí keš (po uložení; jiný proces ji obnoví nejpozději za 30 s) */
  invaliduj() {
    this.kes = null;
  }

  /** nastavení ze správy / obec.yml bez ohledu na dostupnost a rodiče */
  async nastaveno(): Promise<StavModulu> {
    const u = await this.ulozene();
    const stav = {} as StavModulu;
    for (const k of KLICE_MODULU) stav[k] = u[k] ?? this.vychozi(k);
    return stav;
  }

  /** skutečný stav: nastaveno + dostupné + zapnutý rodič */
  async stav(): Promise<StavModulu> {
    const n = await this.nastaveno();
    const stav = {} as StavModulu;
    for (const m of MODULY) {
      stav[m.klic] =
        n[m.klic] && this.dostupny(m.klic) && (!m.rodic || (n[m.rodic] && this.dostupny(m.rodic)));
    }
    return stav;
  }

  async zapnuto(klic: KlicModulu): Promise<boolean> {
    return (await this.stav())[klic];
  }

  /** uloží změny ze správy (jen dostupné moduly) a zapíše audit; vrátí, co se změnilo */
  async uloz(
    zmeny: Partial<StavModulu>,
    kdo: { uzivatelId: string | null; ip?: string | null },
  ): Promise<Partial<StavModulu>> {
    this.invaliduj();
    const puvodni = await this.nastaveno();
    const ulozene = { ...(await this.ulozene()) };
    const zmeneno: Partial<StavModulu> = {};
    for (const k of KLICE_MODULU) {
      const v = zmeny[k];
      if (typeof v !== 'boolean' || !this.dostupny(k)) continue;
      ulozene[k] = v;
      if (v !== puvodni[k]) zmeneno[k] = v;
    }
    if (!Object.keys(zmeneno).length) return zmeneno;
    const hodnota = JSON.stringify(ulozene);
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC_NASTAVENI, hodnota })
      .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
      .execute();
    this.invaliduj();
    await zapisAudit(this.db, {
      uzivatelId: kdo.uzivatelId,
      akce: 'moduly.zmena',
      detail: { zmeny: zmeneno },
      ip: kdo.ip ?? null,
    });
    return zmeneno;
  }

  /** profil obce pro šablony: `moduly` podle skutečného stavu (vypnutý infokanál/kvíz zmizí z menu, úvodu, patičky) */
  async obecProSablony(): Promise<ObecProfil> {
    const s = await this.stav();
    return {
      ...this.obec,
      moduly: {
        ...this.obec.moduly,
        infokanal: s.infokanal,
        kviz: s.kviz,
        rezervace: s.rezervace,
        predprodej: s.predprodej,
        spolujizda: s.spolujizda,
        eknihy: s.eknihy,
        knihovna: s.eknihy,
      },
    };
  }

  /** prefixy cest vypnutých modulů (pro skrytí odkazů v menu) */
  async skryteCesty(): Promise<string[]> {
    const s = await this.stav();
    return MODULY.filter((m) => !s[m.klic]).flatMap((m) => m.cesty);
  }

  /** je odkaz (relativní nebo na vlastní doménu) na vypnutý modul? */
  async jeSkryty(url: string, skryte?: string[], base?: string): Promise<boolean> {
    const prefixy = skryte ?? (await this.skryteCesty());
    let cesta = url;
    if (base && cesta.startsWith(base)) cesta = cesta.slice(base.length) || '/';
    if (!cesta.startsWith('/')) return false;
    return prefixy.some((p) => podCestou(cesta, p));
  }
}

/** položka menu (web) — filtr odkazů na vypnuté moduly, rekurzivně */
export interface PolozkaMenu {
  url: string;
  deti: PolozkaMenu[];
  [k: string]: unknown;
}

export function filtrujMenu<T extends PolozkaMenu>(menu: T[], skryte: string[], base = ''): T[] {
  const skryt = (url: string) => {
    let c = url;
    if (base && c.startsWith(base)) c = c.slice(base.length) || '/';
    return c.startsWith('/') && skryte.some((p) => podCestou(c, p));
  };
  return menu
    .filter((m) => !skryt(m.url))
    .map((m) => ({ ...m, deti: filtrujMenu(m.deti as T[], skryte, base) }));
}
