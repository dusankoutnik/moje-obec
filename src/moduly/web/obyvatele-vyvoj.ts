// Vývoj počtu obyvatel podle evidence Ministerstva vnitra (stav k 1. 1. každého roku, muži/ženy do a nad 15 let).
// Zdrojem je stránka obce na mistopisy.cz (přebírá tabulku MV ČR), kterou server stáhne jednou týdně a tabulku
// uloží do `nastaveni` (přežije restart; při výpadku zdroje zůstanou poslední známá data s datem ověření).
// Do textu stránky se vkládá `<figure class="obyvatele-vyvoj" data-obyvatele="vyvoj">` — šablona ji vykreslí jako
// vlastní SVG graf + tabulku (nic se nenačítá z cizího serveru, viz CSP). Nezávisle na tom platí „aktuální počet“
// z administrace obce (obyvatele.ts) — v textu se vkládá zástupkou {{pocet_obyvatel}}.
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

export const KLIC_NASTAVENI = 'obyvatele_vyvoj';
/** jak často se ptát zdroje (data se mění jednou ročně) */
export const INTERVAL_MS = 7 * 86_400_000;

export interface RokObyvatel {
  /** rok, k jehož 1. 1. údaj platí */
  rok: number;
  muziDeti: number;
  muziDospeli: number;
  zenyDeti: number;
  zenyDospele: number;
  celkem: number;
}

export interface UlozenoObyvatele {
  zdrojUrl: string;
  posledniUspech: string | null;
  posledniPokus: string | null;
  chyba: string | null;
  roky: RokObyvatel[];
}

export interface Sloupec {
  rok: number;
  celkem: number;
  d: string;
  hitX: number;
  hitW: number;
  x: number;
  popis: string;
  prvni: boolean;
  posledni: boolean;
}

export interface GrafObyvatel {
  W: number;
  H: number;
  dole: number;
  vlevo: number;
  vpravo: number;
  sloupce: Sloupec[];
  popisky: { x: number; y: number; text: string }[];
}

export interface DataObyvatel {
  roky: RokObyvatel[];
  /** nejnovější řádek (null = zatím žádná data) */
  posledni: RokObyvatel | null;
  nejstarsi: RokObyvatel | null;
  graf: GrafObyvatel | null;
  posledniUspech: Date | null;
  chyba: string | null;
  zdrojUrl: string;
}

const PRAZDNE: UlozenoObyvatele = {
  zdrojUrl: '',
  posledniUspech: null,
  posledniPokus: null,
  chyba: null,
  roky: [],
};

/** řádek tabulky „1.1.2026 31 129 28 155 -3 343“ (změna u nejstaršího roku chybí); mezery už jsou sjednocené */
const RE_RADEK = /1\.\s*1\.\s*(\d{4})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:[-+−]?\d+\s+)?(\d+)\b/g;

/** z HTML stránky mistopisy.cz vytáhne řádky tabulky počtu obyvatel; prázdné pole = stránka tabulku nemá */
export function parsujMistopisy(html: string): RokObyvatel[] {
  // jen textové buňky tabulky (tagy pryč), aby regulární výraz nechytal čísla z atributů
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\s+/g, ' ');
  const i = text.indexOf('Historie počtu obyvatel');
  const cast = i >= 0 ? text.slice(i) : text;
  const out = new Map<number, RokObyvatel>();
  for (const m of cast.matchAll(RE_RADEK)) {
    const [, rok, md, ma, zd, za, celkem] = m.map(Number);
    if (!rok || rok < 1800 || rok > 2200 || !celkem) continue;
    if (md! + ma! + zd! + za! !== celkem) continue; // součet nesedí → nejspíš jiná tabulka
    if (!out.has(rok))
      out.set(rok, { rok, muziDeti: md!, muziDospeli: ma!, zenyDeti: zd!, zenyDospele: za!, celkem });
  }
  return [...out.values()].sort((a, b) => a.rok - b.rok);
}

const W = 760;
const H = 230;
const NAHORE = 26;
const DOLE = H - 28;
const OKRAJ = 8;

function sloupecCesta(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  const f = (n: number) => Math.round(n * 10) / 10;
  return (
    `M${f(x)} ${f(y + h)}V${f(y + rr)}Q${f(x)} ${f(y)} ${f(x + rr)} ${f(y)}` +
    `H${f(x + w - rr)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + rr)}V${f(y + h)}Z`
  );
}

/** sloupcový graf celkového počtu po letech (jedna řada, popisek u prvního a posledního roku, <title> na sloupci) */
export function grafObyvatel(roky: RokObyvatel[], popis: (r: RokObyvatel) => string): GrafObyvatel | null {
  if (!roky.length) return null;
  const n = roky.length;
  const slot = (W - 2 * OKRAJ) / n;
  const sirka = Math.max(4, Math.min(36, slot - 6));
  const max = Math.max(...roky.map((r) => r.celkem));
  const vyska = DOLE - NAHORE;
  const sloupce = roky.map((r, i) => {
    const h = max ? (r.celkem / max) * vyska : 0;
    const x = OKRAJ + i * slot + (slot - sirka) / 2;
    return {
      rok: r.rok,
      celkem: r.celkem,
      d: sloupecCesta(x, DOLE - h, sirka, Math.max(h, 1), 4),
      hitX: Math.round((OKRAJ + i * slot) * 10) / 10,
      hitW: Math.round(slot * 10) / 10,
      x: Math.round(OKRAJ + i * slot + slot / 2),
      popis: popis(r),
      prvni: i === 0,
      posledni: i === n - 1,
    };
  });
  const popisky = sloupce
    .filter((s) => s.prvni || s.posledni)
    .map((s) => ({ x: s.x, y: Math.round(DOLE - (s.celkem / max) * vyska - 8), text: String(s.celkem) }));
  return { W, H, dole: DOLE, vlevo: OKRAJ, vpravo: W - OKRAJ, sloupce, popisky };
}

export class ObyvateleVyvojSluzba {
  private data: UlozenoObyvatele | null = null;
  private bezi: Promise<void> | null = null;

  constructor(
    private db: Db,
    readonly zdrojUrl: string,
    private userAgent: string,
    private log: FastifyBaseLogger,
    public fetchFn: typeof fetch = fetch,
    public hodiny: () => Date = () => new Date(),
  ) {}

  private async nacti(): Promise<UlozenoObyvatele> {
    if (this.data) return this.data;
    const r = await this.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_NASTAVENI)
      .executeTakeFirst();
    const h = r?.hodnota as Partial<UlozenoObyvatele> | undefined;
    this.data = { ...PRAZDNE, ...(h ?? {}), roky: Array.isArray(h?.roky) ? h.roky : [] };
    return this.data;
  }

  private async uloz(d: UlozenoObyvatele) {
    this.data = d;
    const hodnota = JSON.stringify(d);
    await this.db
      .insertInto('nastaveni')
      .values({ klic: KLIC_NASTAVENI, hodnota })
      .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
      .execute();
  }

  async potrebaObnovy(): Promise<boolean> {
    const d = await this.nacti();
    if (!d.roky.length || d.zdrojUrl !== this.zdrojUrl) return true;
    return (
      !d.posledniPokus || this.hodiny().getTime() - Date.parse(d.posledniPokus) >= INTERVAL_MS - 3_600_000
    );
  }

  /** stáhne a uloží tabulku; chyba zdroje nic nesmaže */
  async obnov(vynutit = false): Promise<void> {
    if (this.bezi) return this.bezi;
    this.bezi = (async () => {
      if (!this.zdrojUrl) return;
      if (!vynutit && !(await this.potrebaObnovy())) return;
      const d = await this.nacti();
      const ted = this.hodiny().toISOString();
      try {
        const r = await this.fetchFn(this.zdrojUrl, {
          headers: { 'user-agent': this.userAgent, accept: 'text/html' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const roky = parsujMistopisy(await r.text());
        if (!roky.length) throw new Error('stránka neobsahuje tabulku počtu obyvatel');
        await this.uloz({
          zdrojUrl: this.zdrojUrl,
          posledniUspech: ted,
          posledniPokus: ted,
          chyba: null,
          roky,
        });
        this.log.info({ roky: roky.length, posledni: roky.at(-1)?.rok }, 'počet obyvatel: tabulka obnovena');
      } catch (e) {
        const chyba = e instanceof Error ? e.message : String(e);
        await this.uloz({ ...d, zdrojUrl: this.zdrojUrl, posledniPokus: ted, chyba });
        this.log.warn({ err: e }, 'počet obyvatel: stažení tabulky selhalo');
      }
    })().finally(() => {
      this.bezi = null;
    });
    return this.bezi;
  }

  async stav(popis: (r: RokObyvatel) => string): Promise<DataObyvatel> {
    const d = await this.nacti();
    const roky = d.zdrojUrl === this.zdrojUrl ? d.roky : [];
    return {
      roky,
      posledni: roky.at(-1) ?? null,
      nejstarsi: roky[0] ?? null,
      graf: grafObyvatel(roky, popis),
      posledniUspech: d.posledniUspech ? new Date(d.posledniUspech) : null,
      chyba: d.chyba,
      zdrojUrl: this.zdrojUrl,
    };
  }
}
