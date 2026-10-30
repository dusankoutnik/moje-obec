// Ochrana kontaktního formuláře před roboty (2026-10-30, po spamu „lead generation“ na obecní e-maily).
// Roboti, kteří prošli: načetli /kontakt, za 2–5 s POST, žádné CSS ani JavaScript, past na roboty prázdná
// (vyplňují jen viditelná pole). Proto tři vrstvy bez CAPTCHA (přístupnost, žádné cizí servery):
//   1) ověření, že stránku zpracoval prohlížeč — JavaScript opíše podepsaný token z `data-overeni` do skrytého pole,
//   2) minimální doba od zobrazení formuláře (člověk zprávu píše aspoň pár sekund),
//   3) bodování obsahu: odkazy, anglický text bez češtiny, reklamní slova; česká diakritika body ubírá.
// Výsledek: skóre ≥ ZAHODIT = zpráva se tiše zahodí (odpověď jako u člověka, audit bez obsahu),
// ≥ OZNACIT = e-mail odejde s předmětem „[možný spam]“ a důvody v hlavičce. Bez JavaScriptu člověk psaný česky projde
// nejvýš s označením, nikdy se nezahodí jen kvůli chybějícímu JS.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRAH = { OZNACIT: 3, ZAHODIT: 5 } as const;
/** nejkratší doba od zobrazení formuláře po odeslání, kterou považujeme za lidskou */
export const MIN_SEKUND = 6;
/** nejdelší platnost tokenu (stránka otevřená přes noc se po odeslání jen označí, nezahodí) */
const MAX_SEKUND = 24 * 3600;

/** token do `data-overeni`: čas zobrazení podepsaný tajemstvím a id sezení (replay z jiného sezení neprojde) */
export function vytvorOvereni(tajemstvi: string, sezeni: string, ted = Date.now()): string {
  const ts = String(ted);
  return `${ts}.${podpis(tajemstvi, sezeni, ts)}`;
}

function podpis(tajemstvi: string, sezeni: string, ts: string) {
  return createHmac('sha256', tajemstvi).update(`kontakt|${sezeni}|${ts}`).digest('base64url');
}

/** vrátí čas zobrazení z platného tokenu, jinak null */
export function overOvereni(tajemstvi: string, sezeni: string, token: unknown): number | null {
  const s = String(token ?? '');
  const i = s.indexOf('.');
  if (i < 1) return null;
  const ts = s.slice(0, i),
    sig = s.slice(i + 1);
  if (!/^\d{10,16}$/.test(ts)) return null;
  const ocek = Buffer.from(podpis(tajemstvi, sezeni, ts));
  const dany = Buffer.from(sig);
  if (ocek.length !== dany.length || !timingSafeEqual(ocek, dany)) return null;
  return Number(ts);
}

const ANGLICKA = new Set(
  (
    'the and you your we our are is for with this that from have will can if it of free click here website business ' +
    'offer company please hello hi there get more any all not by just how what when which they them who use about'
  ).split(' '),
);
const CESKA_SLOVA =
  /\b(dobrý|dobry|den|prosím|prosim|děkuji|dekuji|dotaz|obec|obce|úřad|urad|zda|jestli|jak|kde|kdy|bych|byl|byla|jsme|jsem|máte|mate|poplatek|odpad|rezervace|zastupitelstvo)\b/i;
const DIAKRITIKA = /[ěščřžýáíéůúďťňóĚŠČŘŽÝÁÍÉŮÚĎŤŇÓ]/g;
const ODKAZ = /\b(https?:\/\/|www\.)\S+/gi;
const REKLAMA = [
  /unsubscribe/i,
  /lead ?gen/i,
  /\bSEO\b/,
  /backlink/i,
  /rank(ing)? (on|in) google/i,
  /marketing/i,
  /contact form/i,
  /\d+ ?days? free/i,
  /free trial/i,
  /crypto|bitcoin/i,
  /casino/i,
  /\bloan\b/i,
  /web ?design/i,
  /your (website|business|site)/i,
  /ai (voice|agent|chatbot)/i,
  /traffic to/i,
  /optimi[sz]ation/i,
  /no card (is )?needed/i,
  /opt[- ]?out/i,
];

export interface SignalySpamu {
  /** čas zobrazení formuláře (z tokenu nebo sezení), null = nevíme */
  zobrazeno: number | null;
  /** token z JavaScriptu byl platný */
  jsOk: boolean;
  ted?: number;
}

export interface Hodnoceni {
  skore: number;
  duvody: string[];
}

/** spočítá skóre podezření; čistě z textu a signálů, bez vedlejších účinků */
export function ohodnotZpravu(
  f: { jmeno?: string; email?: string; telefon?: string; zprava?: string },
  s: SignalySpamu,
): Hodnoceni {
  const duvody: string[] = [];
  let skore = 0;
  const zprava = String(f.zprava ?? '');
  const vse = `${f.jmeno ?? ''} ${f.email ?? ''} ${zprava}`;

  if (!s.jsOk) {
    skore += 3;
    duvody.push('bez JavaScriptu');
  }
  if (s.zobrazeno != null) {
    const sek = ((s.ted ?? Date.now()) - s.zobrazeno) / 1000;
    if (sek < MIN_SEKUND) {
      skore += 3;
      duvody.push(`odesláno za ${Math.max(0, Math.round(sek))} s`);
    } else if (sek > MAX_SEKUND) {
      skore += 1;
      duvody.push('formulář zobrazený před více než dnem');
    }
  }

  const odkazy = (zprava.match(ODKAZ) ?? []).length;
  if (odkazy) {
    skore += Math.min(4, 1 + odkazy);
    duvody.push(`odkazy: ${odkazy}`);
  }

  const slova = zprava.toLowerCase().match(/[a-z']+/g) ?? [];
  const anglicka = new Set(slova.filter((w) => ANGLICKA.has(w)));
  const diakritika = (zprava.match(DIAKRITIKA) ?? []).length;
  const cesky = diakritika >= 3 || CESKA_SLOVA.test(zprava);
  if (anglicka.size >= 4 && !cesky) {
    skore += 3;
    duvody.push('anglický text bez češtiny');
  } else if (cesky && diakritika >= 3) {
    skore -= 2;
    duvody.push('česky s diakritikou');
  }

  // robotí vizitka: slepené jméno („RobertVax“) a telefon, který není české/slovenské číslo (např. 83634687879)
  const jmeno = String(f.jmeno ?? '').trim();
  if (/^[A-Z][a-z]+[A-Z][a-z]+$/.test(jmeno)) {
    skore += 1;
    duvody.push('slepené jméno');
  }
  const cislice = String(f.telefon ?? '').replace(/\D/g, '');
  if (cislice && !/^(42[01])?\d{9}$/.test(cislice)) {
    skore += 1;
    duvody.push('cizí telefon');
  }

  const reklama = REKLAMA.filter((r) => r.test(vse)).length;
  if (reklama) {
    skore += Math.min(3, 1 + reklama);
    duvody.push(`reklamní slova: ${reklama}`);
  }

  return { skore: Math.max(0, skore), duvody };
}
