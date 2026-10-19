// Vzhled webu obce: barevné schéma (nebo vlastní barva z obec.yml / správy), písmo, výchozí velikost písma,
// znak, fotky pozadí (pevná / náhodná / střídání) a motto. Výchozí hodnoty z obec.yml, správa je přepíše
// v administraci (nastaveni.web_vzhled); před každou změnou se uloží předchozí stav (tlačítko „Vrátit zpět“).
import type { ObecProfil } from '../../config/obec.js';
import type { Db } from '../../db/index.js';
import { paleta, type Paleta } from '../../lib/barvy.js';
import { zapisAudit } from '../../lib/audit.js';
import { cssSchematu, schemaPodleId, type Schema } from './schemata.js';
import {
  cssPisma,
  fontFace,
  jeVelikost,
  pismoPodleId,
  slozPismo,
  type Pismo,
  type Velikost,
} from './pisma.js';

export type RezimPozadi = 'pevne' | 'nahodne' | 'stridani';

export interface UlozenyVzhled {
  barva?: string;
  /** id schématu, nebo 'vlastni' = barva z pole barva */
  schema?: string;
  pismo?: string;
  velikost?: Velikost;
  znak_id?: string | null;
  foto_id?: string | null;
  foto_alt?: string;
  motto?: string;
  /** název obce v hlavičce a v úvodu (výchozí z obec.yml) */
  nazev?: string;
  nazev_styl?: NazevStyl;
  pozadi_ids?: string[];
  /** vlastní kombinace písem (pismo = 'vlastni'): id z katalogu RODINY */
  pismo_telo?: string;
  pismo_nadpis?: string;
  pismo_titulek?: string;
  pozadi_rezim?: RezimPozadi;
  pozadi_pevne?: string | null;
  predchozi?: Omit<UlozenyVzhled, 'predchozi'> | null;
}

export type NazevStyl = 'normalni' | 'verzalky' | 'kapitalky';
export const STYLY_NAZVU: NazevStyl[] = ['normalni', 'verzalky', 'kapitalky'];

export interface Vzhled {
  barva: string;
  schema: Schema | null;
  paleta: Paleta;
  pismo: Pismo;
  velikost: Velikost;
  znakId: string | null;
  znakUrl: string;
  fotoUrl: string;
  fotoAlt: string;
  motto: string;
  nazev: string;
  nazevStyl: NazevStyl;
  pozadi: string[];
  pozadiRezim: RezimPozadi;
  pozadiPevne: string | null;
  /** CSS proměnné barev a písma + @font-face (vkládá se do <head>) */
  css: string;
  ulozeno: UlozenyVzhled;
}

const urlFotky = (id: string, pripona = 'jpg') => `/soubory/${id}/foto.${pripona}`;

export class VzhledSluzba {
  private cache: Vzhled | null = null;
  constructor(
    private db: Db,
    private obec: ObecProfil,
  ) {}

  private async ulozene(): Promise<UlozenyVzhled> {
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', 'web_vzhled')
      .executeTakeFirst();
    return (r?.hodnota ?? {}) as UlozenyVzhled;
  }

  /** sestaví vzhled z uložených hodnot; `zmeny` = náhled (nic se neukládá) */
  async sestav(u: UlozenyVzhled): Promise<Vzhled> {
    const ids = [u.znak_id, u.foto_id, ...(u.pozadi_ids ?? [])].filter((x): x is string => !!x);
    const soubory = ids.length
      ? await this.db.selectFrom('soubory').select(['id', 'pripona']).where('id', 'in', ids).execute()
      : [];
    const pripona = new Map(soubory.map((s) => [s.id, s.pripona]));
    const url = (id: string | null | undefined) =>
      id && pripona.has(id) ? urlFotky(id, pripona.get(id)) : '';
    const barva = u.barva || this.obec.vzhled.barva;
    const schema =
      u.schema === 'vlastni' ? null : (schemaPodleId(u.schema ?? this.obec.vzhled.schema) ?? null);
    const pismo =
      (u.pismo === 'vlastni' ? slozPismo(u.pismo_telo, u.pismo_nadpis, u.pismo_titulek) : null) ??
      pismoPodleId(u.pismo ?? this.obec.vzhled.pismo);
    const velikost = jeVelikost(u.velikost) ? u.velikost : this.obec.vzhled.velikost;
    const pozadi = (u.pozadi_ids ?? []).filter((id) => pripona.has(id));
    const p = paleta(barva);
    const barvyCss = schema
      ? cssSchematu(schema)
      : `:root{--primarni:${p.primarni};--na-tmave:#ffffff;--akcent:#ffd600;--aktivni:#ffffff;--aktivni-text:${p.tmava};--tmava:#151a16;--svetla:${p.svetla};--gradient-hore:rgba(15,20,16,.72);--gradient-dole:rgba(15,20,16,.9);--sklo:rgba(15,20,16,.45);--sklo-husty:rgba(15,20,16,.82);--primarni-pruhledna:${p.primarni}73;--zelena:${p.primarni};--zelena-tmava:${p.tmava};--zelena-svetla:${p.svetla}}`;
    return {
      barva,
      schema,
      paleta: p,
      pismo,
      velikost,
      znakId: u.znak_id && pripona.has(u.znak_id) ? u.znak_id : null,
      znakUrl: url(u.znak_id) || this.obec.vzhled.znak,
      fotoUrl: url(u.foto_id) || url(pozadi[0]) || this.obec.vzhled.uvodni_foto,
      fotoAlt: u.foto_alt ?? '',
      motto: u.motto ?? this.obec.vzhled.motto,
      nazev: u.nazev?.trim() || this.obec.obec.kratky_nazev,
      nazevStyl: u.nazev_styl && STYLY_NAZVU.includes(u.nazev_styl) ? u.nazev_styl : 'normalni',
      pozadi: pozadi.map((id) => url(id)),
      pozadiRezim: u.pozadi_rezim ?? 'stridani',
      pozadiPevne: u.pozadi_pevne && pozadi.includes(u.pozadi_pevne) ? url(u.pozadi_pevne) : null,
      css: fontFace([pismo]) + cssPisma(pismo) + barvyCss,
      ulozeno: u,
    };
  }

  async nacti(): Promise<Vzhled> {
    if (!this.cache) this.cache = await this.sestav(await this.ulozene());
    return this.cache;
  }

  async uloz(zmena: UlozenyVzhled, aktorId: string, ip?: string | null) {
    const stary = await this.ulozene();
    const { predchozi: _, ...bezHistorie } = stary;
    const novy: UlozenyVzhled = { ...stary, ...zmena, predchozi: bezHistorie };
    await this.zapis(novy);
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.vzhled',
      detail: { zmena: Object.keys(zmena) },
      ip,
    });
  }

  /** vrátit předchozí vzhled (a současný si zapamatovat, aby šlo vrátit i návrat) */
  async vratZpet(aktorId: string, ip?: string | null): Promise<boolean> {
    const stary = await this.ulozene();
    if (!stary.predchozi) return false;
    const { predchozi, ...soucasny } = stary;
    await this.zapis({ ...predchozi, predchozi: soucasny });
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.vzhled_zpet', ip });
    return true;
  }

  private async zapis(v: UlozenyVzhled) {
    await this.db
      .insertInto('nastaveni')
      .values({ klic: 'web_vzhled', hodnota: JSON.stringify(v) })
      .onConflict((oc) =>
        oc.column('klic').doUpdateSet({ hodnota: JSON.stringify(v), upraven_at: new Date() }),
      )
      .execute();
    this.cache = null;
  }

  zahodKes() {
    this.cache = null;
  }
}
