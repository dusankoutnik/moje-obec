// Texty automatických hlášení (SMS, e-mail) — podle VlastiKanálu. SMS píšeme česky, fronta diakritiku odstraní.
import type { Odstavka } from '../../odstavky/cez.js';
import { CEZ_WEB, popisUlice } from '../../odstavky/cez.js';
import { rozsah } from './cas.js';
import { CHMU_WEB, STUPEN_AKUZATIV, STUPEN_CS, type VystrahaChmu } from './chmu.js';
import { SCVK_WEB, castiZTitulku, type UdalostScvk } from './scvk.js';

export interface KontextTextu {
  baseUrl: string;
  /** krátký název obce („Vlastibořice“) */
  obec: string;
  /** všechny části obce z profilu */
  casti: string[];
  nazevKanalu: string;
  /** oblast výstrah ČHMÚ v textu („Turnovsko“ / „ORP 5109“) */
  oblast: string;
}

export interface TextyHlaseni {
  titulek: string;
  smsText: string;
  emailPredmet: string;
  emailText: string;
  /** dotčené části obce (prázdné = celá obec) */
  casti: string[];
}

const kratkyOdkaz = (k: KontextTextu) => `${k.baseUrl.replace(/^https?:\/\//, '')}/infokanal/vystrahy`;
const radky = (r: (string | null | undefined)[]) =>
  r
    .filter((l): l is string => l !== null && l !== undefined)
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n')
    .trim();

/** části obce, které odpovídají názvům ze zdroje (začátek názvu: „Jivina“ ~ „Jivina u Mnichova Hradiště“) */
export function castiObce(nazvy: string[], casti: string[]): string[] {
  const nalezene = casti.filter((c) => nazvy.some((n) => n && n.startsWith(c)));
  return nalezene.length === casti.length ? [] : nalezene;
}
const kde = (k: KontextTextu, casti: string[]) => (casti.length ? casti.join(', ') : k.obec);

// ---- ČHMÚ ----
export function textyChmu(w: VystrahaChmu, k: KontextTextu): TextyHlaseni {
  const st = STUPEN_CS[w.stupen];
  const kdy = rozsah(w.od, w.do);
  return {
    titulek: `${w.jev} (${st} výstraha)`,
    smsText: `VÝSTRAHA ČHMÚ (${st}): ${w.jev}, ${kdy}. Více: ${kratkyOdkaz(k)}`,
    emailPredmet: `Výstraha ČHMÚ (${st}): ${w.jev} — ${kdy}`,
    emailText: radky([
      `Český hydrometeorologický ústav vydal ${STUPEN_AKUZATIV[w.stupen]} výstrahu pro oblast ${k.oblast} (${k.obec} a okolí).`,
      '',
      `Jev: ${w.jev}`,
      `Platnost: ${kdy}`,
      w.popis ? `\n${w.popis}` : null,
      w.pokyny ? `\nDoporučení: ${w.pokyny}` : null,
      '',
      `Aktuální výstrahy: ${CHMU_WEB}`,
      `Tuto zprávu rozeslal ${k.nazevKanalu} automaticky podle výstrahy ČHMÚ.`,
    ]),
    casti: [],
  };
}

// ---- ČEZ ----
export type DruhZpravy = 'nova' | 'pripominka' | 'zmena' | 'zruseni' | 'konec';

/** dotčená místa odstávky (řádky do e-mailu) a části obce pro cílení */
export function mistaCez(o: Odstavka, casti: string[]) {
  const mista: string[] = [];
  for (const c of o.casti) {
    const ulice = c.ulice.map(popisUlice).filter(Boolean);
    mista.push(`${c.nazev}${ulice.length ? ': ' + ulice.join('; ') : ''}`);
  }
  for (const p of o.parcely) mista.push(`pozemky v k. ú. ${p.katastr} (${p.parcely.length})`);
  const nazvy = [...o.casti.map((c) => c.nazev), ...o.parcely.map((p) => p.katastr)];
  return { mista, casti: castiObce(nazvy, casti) };
}

export function textyCez(o: Odstavka, druh: DruhZpravy, k: KontextTextu): TextyHlaseni {
  const { mista, casti } = mistaCez(o, k.casti);
  const kdy = rozsah(o.od, o.do);
  const misto = kde(k, casti);
  const hlava = {
    nova: 'Plánovaná odstávka elektřiny',
    pripominka: 'Připomínáme: ZÍTRA odstávka elektřiny',
    zmena: 'ZMĚNA odstávky elektřiny',
    zruseni: 'ZRUŠENA odstávka elektřiny',
    konec: 'Odstávka elektřiny skončila',
  }[druh];
  const predmet = {
    nova: 'Plánovaná odstávka elektřiny',
    pripominka: 'Připomínka: zítra odstávka elektřiny',
    zmena: 'Změna termínu odstávky elektřiny',
    zruseni: 'Zrušena odstávka elektřiny',
    konec: 'Odstávka elektřiny skončila',
  }[druh];
  return {
    titulek: `Odstávka elektřiny ${kdy} (${misto})`,
    smsText: `${hlava} ČEZ: ${kdy}, ${misto}. Seznam domů: ${kratkyOdkaz(k)}`,
    emailPredmet: `${predmet}: ${kdy} (${misto})`,
    emailText: radky([
      druh === 'zruseni'
        ? `ČEZ Distribuce zrušila plánovanou odstávku elektřiny ${kdy}. Elektřina v tu dobu poteče normálně.`
        : `ČEZ Distribuce ${druh === 'zmena' ? 'změnila termín plánované odstávky' : 'oznamuje plánovanou odstávku'} elektřiny v obci ${k.obec}.`,
      '',
      `Termín: ${kdy}`,
      '',
      'Dotčená místa:',
      ...mista.map((m) => `• ${m}`),
      o.pdf ? `\nOznámení ČEZ (PDF): ${o.pdf}` : null,
      '',
      `Informace o odstávkách: ${CEZ_WEB} (tel. 800 850 860)`,
      `Tuto zprávu rozeslal ${k.nazevKanalu} automaticky podle údajů ČEZ Distribuce.`,
    ]),
    casti,
  };
}

// ---- SčVK ----
export function textyScvk(e: UdalostScvk, druh: DruhZpravy, k: KontextTextu): TextyHlaseni {
  const casti = castiObce(castiZTitulku(e.titulek), k.casti);
  const kdy = rozsah(e.od, e.do);
  const misto = kde(k, casti);
  const hav = e.typ === 'havarie';
  const hlava = {
    nova: hav ? 'HAVÁRIE VODY — přerušená dodávka' : 'Plánovaná odstávka vody',
    pripominka: 'Připomínáme: ZÍTRA odstávka vody',
    zmena: hav ? 'ZMĚNA: havárie vody' : 'ZMĚNA odstávky vody',
    zruseni: 'ZRUŠENA odstávka vody',
    konec: 'Dodávka vody obnovena',
  }[druh];
  const predmet = {
    nova: hav ? 'Havárie vody: přerušená dodávka' : 'Plánovaná odstávka vody',
    pripominka: 'Připomínka: zítra odstávka vody',
    zmena: hav ? 'Změna u havárie vody' : 'Změna termínu odstávky vody',
    zruseni: 'Zrušena odstávka vody',
    konec: 'Dodávka vody obnovena',
  }[druh];
  const nahradni = /náhradní zásobování nebude/i.test(e.text)
    ? 'Náhradní zásobování nebude.'
    : /náhradní zásobování/i.test(e.text)
      ? 'Náhradní zásobování viz podrobnosti.'
      : '';
  const uvod = {
    nova: hav
      ? `SčVK hlásí havárii na vodovodu: dodávka pitné vody je přerušena (${e.titulek}).`
      : `SčVK oznamuje plánovanou odstávku vody (${e.titulek}).`,
    pripominka: `Připomínáme zítřejší plánovanou odstávku vody (${e.titulek}).`,
    zmena: `SčVK změnila termín (${e.titulek}).`,
    zruseni: `SčVK zrušila plánovanou odstávku vody ${kdy}. Voda v tu dobu poteče normálně.`,
    konec: `SčVK ukončila odstávku vody (${e.titulek}) dříve, než bylo ohlášeno. Dodávka vody je obnovena.`,
  }[druh];
  const bezTextu = druh === 'zruseni' || druh === 'konec';
  return {
    titulek: `${hav ? 'Havárie vody' : 'Odstávka vody'} ${kdy} (${misto})`,
    smsText: `${hlava} SčVK: ${kdy}, ${misto}. ${nahradni} Podrobnosti: ${kratkyOdkaz(k)}`
      .replace(/\s+/g, ' ')
      .trim(),
    emailPredmet: `${predmet}: ${kdy} (${misto})`,
    emailText: radky([
      uvod,
      '',
      `Termín: ${kdy}`,
      '',
      bezTextu ? null : e.text || null,
      bezTextu ? null : '',
      e.soubor ? `Seznam dotčených odběrných míst: ${e.soubor}` : null,
      `Podrobnosti na webu SčVK: ${SCVK_WEB}${e.href}`,
      '',
      `Informace o odstávkách a haváriích: ${SCVK_WEB}/`,
      `Tuto zprávu rozeslal ${k.nazevKanalu} automaticky podle údajů SčVK.`,
    ]),
    casti,
  };
}
