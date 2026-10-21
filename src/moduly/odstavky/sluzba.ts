// Odstávky elektřiny: stahování z API (zřídka — API při rychlých dotazech vrací 429), uložení posledních známých
// dat do tabulky `nastaveni` (přežijí restart, při výpadku zdroje se ukazuje poslední stav s časem ověření)
// a historie posledních 30 dní pro stránku /odstavky.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { CEZ_API, jeOdpovedApi, prevedOdpoved, type Odstavka } from './cez.js';

export const KLIC_NASTAVENI = 'odstavky_cez';
/** běžný interval obnovy (keš) */
export const INTERVAL_MS = 60 * 60_000;
/** po odpovědi 429 (příliš mnoho dotazů) se nejméně tak dlouho nic nezkouší */
export const PAUZA_429_MS = 3 * 60 * 60_000;
/** jak dlouho držet proběhlé a zrušené odstávky v historii */
export const HISTORIE_MS = 30 * 86_400_000;

export interface OdstavkyNastaveni {
  kodObce: string;
  /** stránka ČEZ Distribuce pro obec (odkaz z banneru ČEZ), jinak obecná stránka o odstávkách */
  odkazCez: string;
  /** User-Agent dotazů (identifikace instalace — API je neoficiální, chováme se slušně) */
  userAgent: string;
}

interface UlozenaOdstavka extends Omit<Odstavka, 'od' | 'do' | 'zruseno'> {
  od: string;
  do: string | null;
  zruseno: string | null;
}

interface Ulozeno {
  posledniUspech: string | null;
  posledniPokus: string | null;
  chyba: string | null;
  dalsiPokusPo: string | null;
  odstavky: UlozenaOdstavka[];
}

export interface StavOdstavek {
  /** budoucí a probíhající (včetně zrušených budoucích — šablona je označí) podle začátku */
  aktualni: (Odstavka & { probiha: boolean })[];
  /** proběhlé nebo zrušené za posledních 30 dní, nejnovější první */
  historie: Odstavka[];
  posledniUspech: Date | null;
  chyba: string | null;
  odkazCez: string;
}

const PRAZDNE: Ulozeno = {
  posledniUspech: null,
  posledniPokus: null,
  chyba: null,
  dalsiPokusPo: null,
  odstavky: [],
};

const naDatum = (s: string | null) => (s ? new Date(s) : null);
function zUlozene(o: UlozenaOdstavka): Odstavka {
  return { ...o, od: new Date(o.od), do: naDatum(o.do), zruseno: naDatum(o.zruseno) };
}
function doUlozene(o: Odstavka): UlozenaOdstavka {
  return {
    ...o,
    od: o.od.toISOString(),
    do: o.do?.toISOString() ?? null,
    zruseno: o.zruseno?.toISOString() ?? null,
  };
}
const konec = (o: Odstavka) => (o.do ?? o.od).getTime();

export class OdstavkySluzba {
  private data: Ulozeno | null = null;
  private bezi: Promise<void> | null = null;

  constructor(
    private db: Db,
    readonly nastaveni: OdstavkyNastaveni,
    private log: FastifyBaseLogger,
    /** kvůli testům: vlastní fetch a hodiny */
    public fetchFn: typeof fetch = fetch,
    public hodiny: () => Date = () => new Date(),
  ) {}

  private async nacti(): Promise<Ulozeno> {
    if (this.data) return this.data;
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirst();
    const h = r?.hodnota as Partial<Ulozeno> | undefined;
    this.data = { ...PRAZDNE, ...(h ?? {}), odstavky: Array.isArray(h?.odstavky) ? h.odstavky : [] };
    return this.data;
  }

  private async uloz(d: Ulozeno) {
    this.data = d;
    const hodnota = JSON.stringify(d);
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC_NASTAVENI, hodnota })
      .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
      .execute();
  }

  /** je čas na další dotaz? (keš 1 h, po 429 delší pauza) */
  async potrebaObnovy(): Promise<boolean> {
    const d = await this.nacti();
    const ted = this.hodiny().getTime();
    if (d.dalsiPokusPo && ted < Date.parse(d.dalsiPokusPo)) return false;
    return !d.posledniPokus || ted - Date.parse(d.posledniPokus) >= INTERVAL_MS - 60_000;
  }

  /** stáhne aktuální odstávky; chyba zdroje nic nesmaže (zůstanou poslední známá data) */
  async obnov(vynutit = false): Promise<void> {
    if (this.bezi) return this.bezi;
    this.bezi = (async () => {
      if (!vynutit && !(await this.potrebaObnovy())) return;
      const d = await this.nacti();
      const ted = this.hodiny();
      const zaklad = { ...d, posledniPokus: ted.toISOString() };
      try {
        const r = await this.fetchFn(CEZ_API + encodeURIComponent(this.nastaveni.kodObce), {
          headers: { 'user-agent': this.nastaveni.userAgent, accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status === 429) {
          const ra = Number(r.headers.get('retry-after'));
          const pauza = Math.max(PAUZA_429_MS, Number.isFinite(ra) ? ra * 1000 : 0);
          await this.uloz({
            ...zaklad,
            chyba: 'ČEZ omezil počet dotazů (HTTP 429)',
            dalsiPokusPo: new Date(ted.getTime() + pauza).toISOString(),
          });
          this.log.warn('odstávky ČEZ: HTTP 429, další pokus později');
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: unknown = await r.json();
        if (!jeOdpovedApi(j)) throw new Error('neočekávaný tvar odpovědi');
        const nove = prevedOdpoved(j, this.nastaveni.kodObce);
        const ids = new Set(nove.map((o) => o.id));
        // historie: proběhlé a zrušené z dřívějška, které už API neposílá; budoucí, které zmizely, se zahodí
        const hranice = ted.getTime() - HISTORIE_MS;
        const stare = d.odstavky
          .map(zUlozene)
          .filter((o) => !ids.has(o.id) && (konec(o) < ted.getTime() || o.zruseno) && konec(o) >= hranice);
        const vse = [...nove, ...stare].filter((o) => konec(o) >= hranice);
        await this.uloz({
          ...zaklad,
          posledniUspech: ted.toISOString(),
          chyba: null,
          dalsiPokusPo: null,
          odstavky: vse.map(doUlozene),
        });
      } catch (e) {
        const zprava = (e as Error).message;
        this.log.warn({ err: zprava }, 'odstávky ČEZ: zdroj nedostupný, ponechávám poslední data');
        await this.uloz({ ...zaklad, chyba: zprava });
      }
    })().finally(() => {
      this.bezi = null;
    });
    return this.bezi;
  }

  async stav(): Promise<StavOdstavek> {
    const d = await this.nacti();
    const ted = this.hodiny().getTime();
    const hranice = ted - HISTORIE_MS;
    const vse = d.odstavky.map(zUlozene);
    const aktualni = vse
      .filter((o) => konec(o) >= ted)
      .map((o) => ({ ...o, probiha: !o.zruseno && o.od.getTime() <= ted }))
      .sort((a, b) => a.od.getTime() - b.od.getTime());
    const historie = vse
      .filter((o) => konec(o) < ted && konec(o) >= hranice)
      .sort((a, b) => b.od.getTime() - a.od.getTime());
    return {
      aktualni,
      historie,
      posledniUspech: naDatum(d.posledniUspech),
      chyba: d.chyba,
      odkazCez: this.nastaveni.odkazCez,
    };
  }
}
