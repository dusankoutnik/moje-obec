// Výběr další otázky kvízu — čistá funkce bez DB (testovatelná s pevnou „náhodou“).
//
// Algoritmus „zčásti náhodně, ale určitě od lehčích“ (podrobně v docs/MODULY.md, oddíl Kvíz):
//  1. Kvíz má kola po 10 otázkách. Krok kola určuje cílovou obtížnost podle profilu PROFIL
//     (1,1,2,2,2,3,3,4,4,5) posunutou o −1/0/+1 podle úspěšnosti v předchozím kole (≥ 80 % → +1, ≤ 40 % → −1).
//     První dvě otázky kola mají cíl nejvýš 2 — nikdy se nezačíná těžkou.
//  2. Otázky zodpovězené v tomto kole (a právě zobrazená) se vynechávají, dokud je z čeho brát.
//  3. Pořadí přednosti: neviděné → naposledy zodpovězené špatně → naposledy správně (nejdéle neviděné napřed).
//     Pro každou skupinu se nejdřív hledá přesná obtížnost, pak ±1; až když nic, rozšíří se okruh na celou banku
//     (nejbližší obtížnost, skupiny ve stejném pořadí).
//  4. Ve vybrané množině se střídají kategorie (ne stejná dvakrát za sebou, pokud je výběr) a vybírá se náhodně.
//     Ze „správně zodpovězených“ jen mezi nejdéle neviděnými (čtvrtina, aspoň 3), aby se neopakovaly čerstvé.

export const PROFIL = [1, 1, 2, 2, 2, 3, 3, 4, 4, 5] as const;
export const DELKA_KOLA = PROFIL.length;

export interface Kandidat {
  id: string;
  kategorie: string;
  obtiznost: number;
  /** kolikrát hráč otázku zodpověděl */
  videna: number;
  /** výsledek poslední odpovědi hráče (null = neviděná) */
  posledniSpravne: boolean | null;
  /** čas poslední odpovědi (ms), null = neviděná */
  posledniAt: number | null;
}

export interface StavKola {
  /** kolik otázek tohoto kola už bylo zodpovězeno (0–9) */
  krok: number;
  /** posun obtížnosti z předchozího kola (−1, 0, +1) */
  posun: number;
  /** kategorie naposledy zobrazené otázky */
  posledniKategorie?: string | null;
  /** id otázek zodpovězených v tomto kole — neopakují se, dokud je z čeho brát */
  vynechat?: ReadonlySet<string>;
  /** právě zobrazená (předchozí) otázka — nikdy hned znovu, je-li jiná */
  aktualni?: string | null;
}

const omez = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

export function cilovaObtiznost(krok: number, posun: number): number {
  const k = omez(Math.floor(krok), 0, DELKA_KOLA - 1);
  const cil = omez(PROFIL[k]! + omez(Math.round(posun), -1, 1), 1, 5);
  return k < 2 ? Math.min(cil, 2) : cil;
}

/** posun obtížnosti pro další kolo podle úspěšnosti v tom předchozím */
export function posunPoKole(spravne: number, celkem: number): -1 | 0 | 1 {
  if (celkem <= 0) return 0;
  const podil = spravne / celkem;
  if (podil >= 0.8) return 1;
  if (podil <= 0.4) return -1;
  return 0;
}

/** 0 = neviděná, 1 = naposledy špatně, 2 = naposledy správně */
export function skupina(k: Kandidat): 0 | 1 | 2 {
  if (k.videna === 0 || k.posledniSpravne === null) return 0;
  return k.posledniSpravne ? 2 : 1;
}

function nahodny<T>(pole: readonly T[], nahoda: () => number): T {
  return pole[Math.min(pole.length - 1, Math.floor(nahoda() * pole.length))]!;
}

export function vyberOtazku(
  kandidati: readonly Kandidat[],
  stav: StavKola,
  nahoda: () => number = Math.random,
): Kandidat | null {
  if (!kandidati.length) return null;
  const vynechat = stav.vynechat ?? new Set<string>();
  let fond = kandidati.filter((k) => !vynechat.has(k.id) && k.id !== stav.aktualni);
  if (!fond.length) fond = kandidati.filter((k) => k.id !== stav.aktualni);
  if (!fond.length) fond = [...kandidati];

  const cil = cilovaObtiznost(stav.krok, stav.posun);
  const vzdalenost = (k: Kandidat) => Math.abs(k.obtiznost - cil);
  // na začátku kola nikdy nic těžšího než 2 (ani při rozšíření o ±1)
  const strop = stav.krok < 2 ? 2 : 5;

  let vybrane: Kandidat[] = [];
  let sk: 0 | 1 | 2 = 0;
  hledani: for (const s of [0, 1, 2] as const) {
    for (const d of [0, 1]) {
      const m = fond.filter((k) => skupina(k) === s && vzdalenost(k) <= d && k.obtiznost <= strop);
      if (m.length) {
        vybrane = m;
        sk = s;
        break hledani;
      }
    }
  }
  if (!vybrane.length) {
    // rozšíření na celou banku: nejbližší obtížnost (při shodě lehčí), skupiny ve stejném pořadí
    const serazene = [...fond].sort(
      (a, b) => skupina(a) - skupina(b) || vzdalenost(a) - vzdalenost(b) || a.obtiznost - b.obtiznost,
    );
    const prvni = serazene[0]!;
    sk = skupina(prvni);
    vybrane = serazene.filter(
      (k) => skupina(k) === sk && vzdalenost(k) === vzdalenost(prvni) && k.obtiznost === prvni.obtiznost,
    );
  }

  // střídání kategorií
  if (stav.posledniKategorie) {
    const jine = vybrane.filter((k) => k.kategorie !== stav.posledniKategorie);
    if (jine.length) vybrane = jine;
  }
  // ze správně zodpovězených jen ty nejdéle neviděné
  if (sk === 2 && vybrane.length > 3) {
    const n = Math.max(3, Math.ceil(vybrane.length / 4));
    vybrane = [...vybrane].sort((a, b) => (a.posledniAt ?? 0) - (b.posledniAt ?? 0)).slice(0, n);
  }
  return nahodny(vybrane, nahoda);
}

/** náhodné pořadí odpovědí (Fisher–Yates) — index do pole odpovědí v datech */
export function zamichej(n = 4, nahoda: () => number = Math.random): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(nahoda() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p;
}
