// Fronta textu dokumentů: jeden soubor po druhém (OCR je náročné na paměť i procesor), stav drží tabulka
// soubory_text, takže restart nic neztratí. Řádek se před zpracováním atomicky zabere (FOR UPDATE SKIP LOCKED) —
// dva procesy (překryv při nasazení) tak nezpracují stejný soubor dvakrát. Chyba se opakuje nejvýš 3× s odkladem,
// pak zůstává ke „Zpracovat znovu“ ve správě. Cron à 1 min frontu probouzí a uklízí zaseknuté řádky.
import { sql } from 'kysely';
import { Cron } from 'croner';
import type { Db } from '../db/index.js';
import type { StavTextu, ZdrojTextu } from '../db/types.js';
import { escapujHtml } from './html.js';
import type { Logger } from './logger.js';
import type { SouboroveUloziste } from './soubory.js';
import {
  dostupneNastroje,
  extrahujText,
  jeIndexovatelny,
  MIME_OFFICE,
  MIME_PDF,
  rychlaKontrolaPdf,
  type TextKonfigurace,
  type VysledekTextu,
} from './text-souboru.js';

export interface TextFrontaKonfigurace extends TextKonfigurace {
  /** TEXT_SOUBORU — vypnuto = worker nic nezpracovává (řádky čekají) */
  zapnuto: boolean;
}

export type RezimHromadnehoZarazeni = 'vse' | 'jen-pdf' | 'znovu-chyby' | 'chybejici';

/** stavy, které se při „znovu jen chyby a bez textu“ vracejí do fronty */
const STAVY_K_OPAKOVANI: StavTextu[] = ['chyba', 'bez_textu', 'nepodporovano'];
const MAX_POKUSU = 3;
const ODKLAD_PO_CHYBE_MS = 10 * 60_000;
/** řádek ve stavu zpracovava déle než tohle = proces spadl (limit OCR je 20 min) */
const ZASEKNUTY_PO_MS = 40 * 60_000;
/** nejdelší úsek textu, ve kterém se hledá úryvek (ts_headline nad celými 2 MB by zdržoval) */
const URYVEK_Z_PRVNICH_ZNAKU = 300_000;
/** odhad trvání jednoho souboru, dokud nejsou vlastní měření */
const VYCHOZI_TRVANI_MS = 20_000;

export class TextFronta {
  private bezi = false;
  private casovac: NodeJS.Timeout | null = null;
  private zastaveno = false;
  private cron: Cron | null = null;
  /** právě zpracovávaný soubor (jen informace pro správu) */
  aktualni: { souborId: string; nazev: string; od: Date } | null = null;

  constructor(
    private db: Db,
    private uloziste: SouboroveUloziste,
    readonly cfg: TextFrontaKonfigurace,
    private log: Logger,
  ) {}

  /** bez plánovače (testy): kopni() nic nedělá, frontu zpracuje jen zpracujVse() */
  vypniPlanovac() {
    this.zastaveno = true;
  }

  /** cron à 1 min (probuzení + úklid zaseknutých) a první probuzení chvíli po startu */
  start() {
    if (!this.cfg.zapnuto) {
      this.log.info({}, 'text dokumentů: vypnuto (TEXT_SOUBORU=0), fronta se nezpracovává');
      return;
    }
    this.cron = new Cron('* * * * *', { protect: true }, async () => {
      await this.uklidZaseknute().catch((e) => this.log.warn({ err: e }, 'text dokumentů: úklid'));
      this.kopni();
    });
    this.naplanuj(10_000);
  }

  kopni() {
    if (this.zastaveno || !this.cfg.zapnuto) return;
    if (!this.bezi) this.naplanuj(50);
  }

  zastav() {
    this.zastaveno = true;
    this.cron?.stop();
    if (this.casovac) clearTimeout(this.casovac);
  }

  private naplanuj(ms: number) {
    if (this.zastaveno) return;
    if (this.casovac) clearTimeout(this.casovac);
    this.casovac = setTimeout(() => {
      this.krok().catch((e) => {
        this.log.error({ err: e }, 'text dokumentů: worker spadl, zkusím za 30 s');
        this.bezi = false;
        this.naplanuj(30_000);
      });
    }, ms);
  }

  // ---------- zařazování ----------

  /** zařadí dané soubory (nový řádek, nebo vrácení do fronty); přednostně = priorita 1 */
  async zarad(ids: string[], v: { prednostne?: boolean } = {}): Promise<number> {
    const platne = ids.filter((x) => /^[0-9a-f-]{36}$/.test(x));
    if (!platne.length) return 0;
    const priorita = v.prednostne ? 1 : 0;
    const r = await sql`
      INSERT INTO soubory_text (soubor_id, priorita)
        SELECT s.id, ${priorita}::smallint FROM soubory s WHERE s.id IN (${sql.join(platne)})
      ON CONFLICT (soubor_id) DO UPDATE
        SET stav = 'ceka', pokusu = 0, priorita = EXCLUDED.priorita, chyba = NULL, dalsi_pokus_at = NULL,
            zarazeno_at = now()
        WHERE soubory_text.stav <> 'zpracovava'`.execute(this.db);
    this.kopni();
    return Number(r.numAffectedRows ?? 0);
  }

  /** stejné jako skript src/scripts/text-souboru.ts — jen zařadí, zpracování běží na pozadí */
  async zaradHromadne(rezim: RezimHromadnehoZarazeni): Promise<number> {
    let r;
    if (rezim === 'znovu-chyby') {
      r = await sql`
        UPDATE soubory_text SET stav = 'ceka', pokusu = 0, chyba = NULL, dalsi_pokus_at = NULL, zarazeno_at = now()
         WHERE stav IN (${sql.join(STAVY_K_OPAKOVANI)})`.execute(this.db);
    } else {
      const jenPdf = rezim === 'jen-pdf';
      r = await sql`
        INSERT INTO soubory_text (soubor_id)
          SELECT s.id FROM soubory s
           WHERE ${this.indexovatelnySql()} ${jenPdf ? sql`AND s.mime = ${MIME_PDF}` : sql``}
        ON CONFLICT (soubor_id) DO ${
          rezim === 'chybejici'
            ? sql`NOTHING`
            : sql`UPDATE SET stav = 'ceka', pokusu = 0, chyba = NULL, dalsi_pokus_at = NULL, zarazeno_at = now()
                  WHERE soubory_text.stav <> 'zpracovava'`
        }`.execute(this.db);
    }
    this.kopni();
    return Number(r.numAffectedRows ?? 0);
  }

  /** kolik souborů by hromadné zařazení zasáhlo (pro potvrzení ve správě) */
  async pocetKZarazeni(rezim: RezimHromadnehoZarazeni): Promise<number> {
    if (rezim === 'znovu-chyby') {
      const r = await this.db
        .selectFrom('soubory_text')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('stav', 'in', STAVY_K_OPAKOVANI)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    }
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM soubory s
       WHERE ${this.indexovatelnySql()} ${rezim === 'jen-pdf' ? sql`AND s.mime = ${MIME_PDF}` : sql``}
       ${rezim === 'chybejici' ? sql`AND NOT EXISTS (SELECT 1 FROM soubory_text t WHERE t.soubor_id = s.id)` : sql``}`.execute(
      this.db,
    );
    return r.rows[0]!.n;
  }

  /** podmínka „soubor s indexovatelným textem“: PDF, kancelářský dokument, nebo obrázek jako příloha desky */
  private indexovatelnySql() {
    return sql`(s.mime = ${MIME_PDF} OR s.mime IN (${sql.join(Object.keys(MIME_OFFICE))})
      OR (s.mime IN ('image/jpeg', 'image/png')
          AND EXISTS (SELECT 1 FROM ud_prilohy p WHERE p.soubor_id = s.id)))`;
  }

  // ---------- zpracování ----------

  /** atomicky zabere jeden čekající soubor (přednostní dřív, pak podle pořadí zařazení) */
  private async zaber() {
    const r = await sql<{ soubor_id: string; pokusu: number }>`
      WITH vybrany AS (
        SELECT soubor_id FROM soubory_text
         WHERE stav = 'ceka' AND (dalsi_pokus_at IS NULL OR dalsi_pokus_at <= now())
         ORDER BY priorita DESC, zarazeno_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE soubory_text t SET stav = 'zpracovava', zacatek_at = now(), pokusu = t.pokusu + 1
        FROM vybrany WHERE t.soubor_id = vybrany.soubor_id
      RETURNING t.soubor_id, t.pokusu`.execute(this.db);
    return r.rows[0];
  }

  /** jeden krok: zpracuje jeden soubor; vrací true, když něco zpracoval */
  async krok(): Promise<boolean> {
    if (!this.cfg.zapnuto) return false;
    this.bezi = true;
    const z = await this.zaber();
    if (!z) {
      this.bezi = false;
      return false;
    }
    await this.zpracuj(z.soubor_id, z.pokusu);
    this.naplanuj(50);
    return true;
  }

  /** pro testy a skripty: zpracovat celou frontu hned */
  async zpracujVse(nejvys = 1000): Promise<number> {
    const puvodni = this.zastaveno;
    this.zastaveno = true;
    let n = 0;
    try {
      while (n < nejvys && (await this.krok())) n++;
    } finally {
      this.zastaveno = puvodni;
    }
    return n;
  }

  private async zpracuj(souborId: string, pokusu: number) {
    const zacatek = Date.now();
    const soubor = await this.uloziste.podleId(souborId);
    this.aktualni = { souborId, nazev: soubor?.puvodni_nazev ?? souborId, od: new Date() };
    try {
      if (!soubor) {
        await this.zapisChybu(souborId, 'soubor není v databázi', MAX_POKUSU, zacatek);
        return;
      }
      const cesta = this.uloziste.cesta(soubor.id);
      if (!jeIndexovatelny(soubor.mime, true)) {
        await this.zapisVysledek(souborId, { stav: 'nepodporovano', duvod: `typ ${soubor.mime}` }, zacatek);
        return;
      }
      const v = await extrahujText(cesta, soubor, this.cfg).catch((e: Error) => ({
        stav: 'chyba' as const,
        duvod: (e.message ?? String(e)).slice(0, 300),
      }));
      if (v.stav === 'chyba') {
        await this.zapisChybu(souborId, v.duvod, pokusu, zacatek);
        this.log.warn({ souborId, pokusu, duvod: v.duvod }, 'text dokumentů: chyba');
        return;
      }
      await this.zapisVysledek(souborId, v, zacatek);
      this.log.info(
        { souborId, stav: v.stav, zdroj: 'zdroj' in v ? v.zdroj : null, ms: Date.now() - zacatek },
        'text dokumentů: zpracováno',
      );
    } finally {
      this.aktualni = null;
    }
  }

  private async zapisChybu(souborId: string, duvod: string, pokusu: number, zacatek: number) {
    const vzdat = pokusu >= MAX_POKUSU;
    await this.db
      .updateTable('soubory_text')
      .set({
        stav: vzdat ? 'chyba' : 'ceka',
        chyba: duvod.slice(0, 300),
        dalsi_pokus_at: vzdat ? null : new Date(Date.now() + ODKLAD_PO_CHYBE_MS),
        zpracovano_at: new Date(),
        trvani_ms: Date.now() - zacatek,
      })
      .where('soubor_id', '=', souborId)
      .where('stav', '=', 'zpracovava')
      .execute();
  }

  private async zapisVysledek(
    souborId: string,
    v: Exclude<VysledekTextu, { stav: 'chyba' }>,
    zacatek: number,
  ) {
    const zaklad = { zpracovano_at: new Date(), trvani_ms: Date.now() - zacatek, priorita: 0 };
    if (v.stav === 'nepodporovano') {
      await this.db
        .updateTable('soubory_text')
        .set({ ...zaklad, stav: 'nepodporovano', chyba: v.duvod.slice(0, 300), text: null, zdroj: null })
        .where('soubor_id', '=', souborId)
        .where('stav', '=', 'zpracovava')
        .execute();
      return;
    }
    // tsvector má strop 1 MB: text plný unikátních „slov“ (nekvalitní OCR) ho může přesáhnout → zkrátit a zkusit znovu
    let text = v.text;
    let poznamka = v.poznamka;
    for (let pokus = 0; ; pokus++) {
      try {
        await this.db
          .updateTable('soubory_text')
          .set({
            ...zaklad,
            stav: v.stav,
            zdroj: v.zdroj,
            text,
            stran: v.stran,
            ma_vrstvu: v.maVrstvu,
            chyba: null,
            poznamka,
          })
          .where('soubor_id', '=', souborId)
          .where('stav', '=', 'zpracovava')
          .execute();
        return;
      } catch (e) {
        const kod = (e as { code?: string }).code;
        if (kod !== '54000' || pokus >= 4 || text.length < 1000) throw e;
        text = text.slice(0, Math.floor(text.length / 2));
        poznamka = [poznamka, `text pro vyhledávání zkrácen na ${text.length} znaků (strop indexu)`]
          .filter(Boolean)
          .join('; ');
      }
    }
  }

  /** řádky zaseknuté ve stavu zpracovava (pád procesu uprostřed OCR) → zpět do fronty, po 3 pokusech chyba */
  async uklidZaseknute(starsiNezMs = ZASEKNUTY_PO_MS): Promise<number> {
    const r = await this.db
      .updateTable('soubory_text')
      .set({
        stav: sql<StavTextu>`CASE WHEN pokusu >= ${MAX_POKUSU} THEN 'chyba' ELSE 'ceka' END`,
        chyba: 'zpracování bylo přerušeno',
        zpracovano_at: new Date(),
      })
      .where('stav', '=', 'zpracovava')
      .where('zacatek_at', '<', new Date(Date.now() - starsiNezMs))
      .executeTakeFirst();
    const n = Number(r.numUpdatedRows ?? 0);
    if (n) this.log.warn({ n }, 'text dokumentů: zaseknuté zpracování vráceno do fronty');
    return n;
  }

  // ---------- přehledy pro správu ----------

  async prehled() {
    const r = await sql<{ stav: StavTextu; n: number }>`
      SELECT stav, count(*)::int AS n FROM soubory_text GROUP BY stav`.execute(this.db);
    const pocty: Record<StavTextu, number> = {
      ceka: 0,
      zpracovava: 0,
      hotovo: 0,
      bez_textu: 0,
      nepodporovano: 0,
      chyba: 0,
    };
    for (const x of r.rows) pocty[x.stav] = x.n;
    const d = await sql<{ dnes: number; prumer: number | null }>`
      SELECT
        (SELECT count(*)::int FROM soubory_text WHERE stav IN ('hotovo', 'bez_textu')
           AND zpracovano_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Prague') AT TIME ZONE 'Europe/Prague')) AS dnes,
        (SELECT avg(trvani_ms) FROM (SELECT trvani_ms FROM soubory_text
           WHERE stav IN ('hotovo', 'bez_textu') AND trvani_ms IS NOT NULL
           ORDER BY zpracovano_at DESC LIMIT 50) x) AS prumer`.execute(this.db);
    const prumerMs = Number(d.rows[0]?.prumer ?? 0) || VYCHOZI_TRVANI_MS;
    const ceka = pocty.ceka + pocty.zpracovava;
    return {
      pocty,
      ceka,
      hotovoDnes: d.rows[0]?.dnes ?? 0,
      /** odhad doby zpracování fronty (s) */
      odhadS: Math.round((ceka * prumerMs) / 1000),
      prumerMs: Math.round(prumerMs),
      aktualni: this.aktualni,
      zapnuto: this.cfg.zapnuto,
      nastroje: await dostupneNastroje(this.cfg.path),
    };
  }

  /** seznam souborů v daném stavu s místem na webu (dokument desky / soubor ke stažení) */
  async seznam(stavy: StavTextu[], limit = 200) {
    return this.db
      .selectFrom('soubory_text as t')
      .innerJoin('soubory as s', 's.id', 't.soubor_id')
      .select([
        't.soubor_id',
        't.stav',
        't.zdroj',
        't.stran',
        't.ma_vrstvu',
        't.chyba',
        't.poznamka',
        't.pokusu',
        't.priorita',
        't.zarazeno_at',
        't.zpracovano_at',
        't.trvani_ms',
        's.puvodni_nazev',
        's.pripona',
        's.velikost',
        's.mime',
      ])
      .select((eb) => [
        eb
          .selectFrom('ud_prilohy as p')
          .innerJoin('ud_dokumenty as d', 'd.id', 'p.dokument_id')
          .whereRef('p.soubor_id', '=', 's.id')
          .select('d.id')
          .orderBy('d.vyveseno_od', 'desc')
          .limit(1)
          .as('deska_id'),
        eb
          .selectFrom('ud_prilohy as p')
          .innerJoin('ud_dokumenty as d', 'd.id', 'p.dokument_id')
          .whereRef('p.soubor_id', '=', 's.id')
          .select('d.nazev')
          .orderBy('d.vyveseno_od', 'desc')
          .limit(1)
          .as('deska_nazev'),
        eb
          .selectFrom('web_dokumenty as w')
          .whereRef('w.soubor_id', '=', 's.id')
          .where('w.smazano_at', 'is', null)
          .select('w.id')
          .limit(1)
          .as('dokument_id'),
        eb
          .selectFrom('web_dokumenty as w')
          .whereRef('w.soubor_id', '=', 's.id')
          .where('w.smazano_at', 'is', null)
          .select('w.nazev')
          .limit(1)
          .as('dokument_nazev'),
        sql<number>`length(t.text)`.as('znaku'),
      ])
      .where('t.stav', 'in', stavy)
      .orderBy('t.priorita', 'desc')
      .orderBy('t.zarazeno_at')
      .limit(limit)
      .execute();
  }

  /** stav textu daných souborů (štítky ve správě desky a dokumentů) */
  async stavy(ids: string[]): Promise<Map<string, { stav: StavTextu; zdroj: ZdrojTextu | null }>> {
    const platne = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/.test(x)))];
    if (!platne.length) return new Map();
    const r = await this.db
      .selectFrom('soubory_text')
      .select(['soubor_id', 'stav', 'zdroj'])
      .where('soubor_id', 'in', platne)
      .execute();
    return new Map(r.map((x) => [x.soubor_id, { stav: x.stav, zdroj: x.zdroj }]));
  }

  /** rychlá kontrola právě nahraného PDF (hláška správci); null = není PDF nebo je funkce vypnutá */
  async rychlaKontrola(soubor: { id: string; mime: string }) {
    if (!this.cfg.zapnuto || soubor.mime !== MIME_PDF) return null;
    return rychlaKontrolaPdf(this.uloziste.cesta(soubor.id), this.cfg);
  }

  // ---------- vyhledávání ----------

  /**
   * Fulltext v textu dokumentů; úryvek se zvýrazněnými slovy jako bezpečné HTML (`<mark>`), text je escapovaný.
   * `dotaz` je tsquery z tsDotaz(). Vrací jen soubory se stavem hotovo.
   */
  async hledej(dotaz: string, limit = 20) {
    const volby = `MaxFragments=2, MaxWords=18, MinWords=8, FragmentDelimiter=" … ", StartSel=\u0001, StopSel=\u0002`;
    const r = await sql<{
      soubor_id: string;
      puvodni_nazev: string;
      pripona: string;
      mime: string;
      zdroj: ZdrojTextu | null;
      rank: number;
      uryvek: string;
    }>`
      WITH q AS (SELECT to_tsquery('simple', ${dotaz}) AS d),
      n AS (
        SELECT t.soubor_id, ts_rank(t.vyhledavani, q.d) AS rank
          FROM soubory_text t, q
         WHERE t.stav = 'hotovo' AND t.vyhledavani @@ q.d
         ORDER BY rank DESC, t.zpracovano_at DESC
         LIMIT ${limit}
      )
      SELECT n.soubor_id, s.puvodni_nazev, s.pripona, s.mime, t.zdroj, n.rank,
             ts_headline('cs_bez', left(t.text, ${URYVEK_Z_PRVNICH_ZNAKU}), q.d, ${volby}) AS uryvek
        FROM n JOIN soubory_text t ON t.soubor_id = n.soubor_id JOIN soubory s ON s.id = n.soubor_id, q
       ORDER BY n.rank DESC`.execute(this.db);
    return r.rows.map((x) => ({
      ...x,
      uryvek: escapujHtml(x.uryvek.replace(/\s+/g, ' ').trim())
        .split('\u0001')
        .join('<mark>')
        .split('\u0002')
        .join('</mark>'),
    }));
  }
}
