// Předpověď počasí: stahování z MET Norway (podmínky API: identifikující User-Agent, respektovat Expires
// a Last-Modified, nejvýš jeden dotaz za 30 min), uložení poslední odpovědi do tabulky `nastaveni` (přežije restart,
// při výpadku zdroje se ukazují poslední známá data s časem) a převod na hodiny/dny při čtení.
// Výstrahy ČHMÚ bere z tabulky ik_vystrahy (stahuje je infokanál), sám nic dalšího nestahuje.
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { jeOdpovedMet, MET_API, prevedMet, type MetOdpoved, type Predpoved } from './met.js';

export const KLIC_NASTAVENI = 'pocasi_met';
/** nejkratší odstup dvou dotazů (i když Expires říká méně) */
export const INTERVAL_MS = 30 * 60_000;
/** starší data se na titulce neukazují */
export const STARI_MS = 12 * 60 * 60_000;

export interface PocasiNastaveni {
  lat: number;
  lon: number;
  nazev: string;
  userAgent: string;
}

interface Ulozeno {
  posledniUspech: string | null;
  posledniPokus: string | null;
  chyba: string | null;
  expires: string | null;
  lastModified: string | null;
  /** souřadnice, pro které odpověď platí (změna v obec.yml = stáhnout znovu) */
  poloha: string | null;
  odpoved: MetOdpoved | null;
}

export type StupenVystrahy = 'yellow' | 'orange' | 'red';
export interface VystrahaPocasi {
  titulek: string;
  stupen: StupenVystrahy;
  od: Date | null;
  do: Date | null;
  /** zveřejněná na /infokanal/vystrahy */
  zverejnena: boolean;
  plati: boolean;
}

export interface StavPocasi extends Predpoved {
  nazev: string;
  /** čas posledního úspěšného ověření dat u MET */
  aktualizovano: Date | null;
  chyba: string | null;
  /** data starší než 12 h (nebo žádná) — titulka dlaždici nevykreslí */
  stara: boolean;
}

const PRAZDNE: Ulozeno = {
  posledniUspech: null,
  posledniPokus: null,
  chyba: null,
  expires: null,
  lastModified: null,
  poloha: null,
  odpoved: null,
};
const PORADI: Record<StupenVystrahy, number> = { yellow: 1, orange: 2, red: 3 };
const datum = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

export class PocasiSluzba {
  private data: Ulozeno | null = null;
  private bezi: Promise<void> | null = null;
  private prevod: { klic: string; p: Predpoved } | null = null;

  constructor(
    private db: Db,
    readonly nastaveni: PocasiNastaveni,
    private log: FastifyBaseLogger,
    /** kvůli testům: vlastní fetch a hodiny */
    public fetchFn: typeof fetch = fetch,
    public hodiny: () => Date = () => new Date(),
  ) {}

  /** souřadnice na 4 desetinná místa (podmínka MET; víc přesnosti nic nepřidá a zhoršuje keš) */
  get poloha(): string {
    return `lat=${this.nastaveni.lat.toFixed(4)}&lon=${this.nastaveni.lon.toFixed(4)}`;
  }
  get url(): string {
    return `${MET_API}?${this.poloha}`;
  }

  private async nacti(): Promise<Ulozeno> {
    if (this.data) return this.data;
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirst();
    const h = r?.hodnota as Partial<Ulozeno> | undefined;
    this.data = { ...PRAZDNE, ...(h ?? {}) };
    if (this.data.odpoved && !jeOdpovedMet(this.data.odpoved)) this.data.odpoved = null;
    return this.data;
  }

  private async uloz(d: Ulozeno) {
    this.data = d;
    this.prevod = null;
    const hodnota = JSON.stringify(d);
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC_NASTAVENI, hodnota })
      .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
      .execute();
  }

  /** je čas na další dotaz? (Expires z poslední odpovědi, ale nejdřív 30 min po posledním pokusu) */
  async potrebaObnovy(): Promise<boolean> {
    const d = await this.nacti();
    if (d.poloha !== this.poloha) return true;
    const ted = this.hodiny().getTime();
    if (d.posledniPokus && ted - Date.parse(d.posledniPokus) < INTERVAL_MS - 30_000) return false;
    const exp = datum(d.expires);
    if (exp && ted < exp.getTime() && d.odpoved) return false;
    return true;
  }

  /** stáhne předpověď; chyba zdroje nic nesmaže (zůstanou poslední známá data) */
  async obnov(vynutit = false): Promise<void> {
    if (this.bezi) return this.bezi;
    this.bezi = (async () => {
      if (!vynutit && !(await this.potrebaObnovy())) return;
      const d = await this.nacti();
      const ted = this.hodiny();
      const stejnaPoloha = d.poloha === this.poloha;
      const zaklad: Ulozeno = { ...d, posledniPokus: ted.toISOString() };
      try {
        const headers: Record<string, string> = {
          'user-agent': this.nastaveni.userAgent,
          accept: 'application/json',
        };
        if (stejnaPoloha && d.odpoved && d.lastModified) headers['if-modified-since'] = d.lastModified;
        const r = await this.fetchFn(this.url, { headers, signal: AbortSignal.timeout(15_000) });
        const expires = r.headers.get('expires');
        if (r.status === 304 && d.odpoved) {
          await this.uloz({
            ...zaklad,
            posledniUspech: ted.toISOString(),
            chyba: null,
            expires: expires ?? d.expires,
          });
          return;
        }
        if (r.status === 429 || r.status === 403) {
          // 403 = MET zablokoval (chybný User-Agent / příliš dotazů) — počkat aspoň hodinu
          await this.uloz({
            ...zaklad,
            chyba: `MET Norway odmítl dotaz (HTTP ${r.status})`,
            expires: new Date(ted.getTime() + 60 * 60_000).toUTCString(),
          });
          this.log.warn({ status: r.status }, 'počasí MET: dotaz odmítnut');
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: unknown = await r.json();
        if (!jeOdpovedMet(j)) throw new Error('neočekávaný tvar odpovědi');
        await this.uloz({
          ...zaklad,
          posledniUspech: ted.toISOString(),
          chyba: null,
          expires,
          lastModified: r.headers.get('last-modified'),
          poloha: this.poloha,
          odpoved: { properties: { meta: j.properties.meta, timeseries: j.properties.timeseries } },
        });
      } catch (e) {
        const zprava = (e as Error).message;
        this.log.warn({ err: zprava }, 'počasí MET: zdroj nedostupný, ponechávám poslední data');
        await this.uloz({ ...zaklad, chyba: zprava });
      }
    })().finally(() => {
      this.bezi = null;
    });
    return this.bezi;
  }

  async stav(): Promise<StavPocasi> {
    const d = await this.nacti();
    const ted = this.hodiny();
    const aktualizovano = datum(d.posledniUspech);
    let p: Predpoved = { ted: null, hodiny: [], dny: [], modelZ: null };
    if (d.odpoved) {
      // převod jednou za hodinu (výsledek závisí na aktuální hodině)
      const klic = `${d.posledniUspech}|${Math.floor(ted.getTime() / 3600_000)}`;
      if (this.prevod?.klic !== klic) this.prevod = { klic, p: prevedMet(d.odpoved, ted) };
      p = this.prevod.p;
    }
    return {
      ...p,
      nazev: this.nastaveni.nazev,
      aktualizovano,
      chyba: d.chyba,
      stara: !aktualizovano || !p.ted || ted.getTime() - aktualizovano.getTime() > STARI_MS,
    };
  }

  /** výstrahy ČHMÚ platné teď nebo začínající do 24 h (bez zahozených a přeskočených), nejzávažnější první */
  async vystrahy(): Promise<VystrahaPocasi[]> {
    const ted = this.hodiny();
    const za24 = new Date(ted.getTime() + 86_400_000);
    const radky = await this.db
      .selectFrom('ik_vystrahy')
      .select(['titulek', 'stupen', 'plati_od', 'plati_do', 'stav'])
      .where('zdroj', '=', 'chmu')
      .where('stav', '=', 'odeslano') // jen rozeslané — odkaz vede na /infokanal/vystrahy, kde nerozeslané nejsou
      .where('zruseno_at', 'is', null)
      .where((eb) => eb.or([eb('plati_do', 'is', null), eb('plati_do', '>', ted)]))
      .where((eb) => eb.or([eb('plati_od', 'is', null), eb('plati_od', '<=', za24)]))
      .orderBy(sql`plati_od nulls first`)
      .execute();
    return radky
      .filter((r): r is typeof r & { stupen: StupenVystrahy } => !!r.stupen && r.stupen in PORADI)
      .map((r) => ({
        titulek: r.titulek,
        stupen: r.stupen,
        od: r.plati_od,
        do: r.plati_do,
        zverejnena: r.stav === 'odeslano',
        plati: !r.plati_od || r.plati_od <= ted,
      }))
      .sort((a, b) => PORADI[b.stupen] - PORADI[a.stupen] || Number(b.plati) - Number(a.plati));
  }
}
