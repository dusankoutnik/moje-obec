// NÁVRH ROZHRANÍ automatických výstrah (etapa 0 — bez implementace). Zdroje: ČHMÚ (CAP XML), ČEZ Distribuce
// (plánované odstávky), SčVK/voda (WFS + HTML). Podrobný rozbor zdrojů je v docs/MODULY.md.
//
// Princip (převzatý z provozu VlastiKanálu): každý zdroj je `ZdrojVystrah`, který při pollingu vrátí aktuální
// události; jádro drží tabulku `ik_vystrahy` (klíč zdroj+externí id), pozná nové / změněné / zrušené události,
// a podle pravidel (`PravidlaZdroje`) buď jen upozorní správce e-mailem, nebo rovnou založí hlášení (`InfokanalSluzba.zalozHlaseni`)
// s `zdrojAutomatu` a kategorií (pocasi | elektrina | voda). Noční události se plánují na ráno.

export type ZdrojId = 'chmu' | 'cez' | 'voda';

export interface UdalostVystrahy {
  zdroj: ZdrojId;
  /** stabilní identifikátor události u zdroje (ČHMÚ: jev|stupeň; ČEZ: id odstávky; voda: id události / hlášenky) */
  externiId: string;
  /** stupeň závažnosti: 1 = informace (jen správcům), 2 = rozeslat (přes den hned, v noci ráno), 3 = krizové (všem hned) */
  stupen: 1 | 2 | 3;
  titulek: string;
  /** text pro SMS (bez prefixu obce, ≤ 300 znaků) */
  smsText: string;
  /** delší text pro e-mail / článek */
  text: string;
  platiOd: Date | null;
  platiDo: Date | null;
  /** části obce, kterých se událost týká (prázdné = celá obec) */
  casti: string[];
  /** odkaz na podrobnosti u zdroje (PDF oznámení, mapa, stránka výstrahy) */
  odkaz?: string;
  /** zrušení dříve ohlášené události (ČEZ zrušená odstávka, ČHMÚ msgType=Cancel) */
  zruseno?: boolean;
}

export interface ZdrojVystrah {
  readonly id: ZdrojId;
  /** interval pollingu (cron výraz); ČHMÚ 10 min, ČEZ 2× denně, voda 15 min */
  readonly cron: string;
  /** stáhne a přeloží aktuální události pro obec z profilu (kod_obce, orp_cisorp, části) */
  nacti(obec: { kodObce: string; orpCisorp: string; casti: string[] }): Promise<UdalostVystrahy[]>;
}

export interface PravidlaZdroje {
  /** kategorie infokanálu, do které automatická hlášení spadají (odhlásitelná, ale doručovaná jako důležitá) */
  kategorieSlug: 'pocasi' | 'elektrina' | 'voda';
  /** v noci (22–6 h) neposílat stupeň 2 hned, naplánovat na tuto hodinu */
  nocniOdlozeniNa: string; // "06:30"
  /** připomínka den předem v tuto hodinu (ČEZ odstávky) */
  pripominkaDenPredem?: string; // "17:00"
  /** po kolika hodinách bez odpovědi zdroje poslat správcům jedno upozornění */
  vypadekZdrojeHodin: number; // 24
}

export interface StavVystrahy {
  id: number;
  zdroj: ZdrojId;
  externiId: string;
  stupen: number;
  stav: 'nova' | 'odeslana' | 'naplanovana' | 'preskocena' | 'zrusena';
  hlaseniId: string | null;
  poprveVidena: Date;
  naposledyVidena: Date;
  payload: UdalostVystrahy;
}
