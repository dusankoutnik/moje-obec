// Povinně zveřejňované informace — struktura podle přílohy č. 1 vyhlášky č. 515/2020 Sb.
// Každý bod: buď se vyplní sám z profilu obce (obec.yml), nebo má výchozí text, který obec jen zkontroluje,
// nebo ho obec musí doplnit (v administraci je pak zvýrazněný jako „chybí“). Vlastní text úřadu má vždy přednost.
// Znění bodů ověřeno podle veřejně dostupného textu vyhlášky; obec si ho má zkontrolovat (není právní poradenství).
import type { ObecProfil } from '../../config/obec.js';
import { escapujHtml as e } from '../../lib/html.js';
import { formatujTelefon } from '../../lib/kontakty.js';

export type StavBodu = 'auto' | 'vychozi' | 'chybi';

export interface BodPi {
  klic: string;
  nazev: string;
  uroven: 1 | 2;
  /** nadpis skupiny bez vlastního obsahu (např. 4. Kontaktní spojení) */
  skupina?: boolean;
  napoveda?: string;
  /** obsah z profilu obce; null = profil ho nemá */
  auto?: (o: ObecProfil, kontext: KontextPi) => string | null;
  vychozi?: (o: ObecProfil, kontext: KontextPi) => string;
}

export interface KontextPi {
  baseUrl: string;
  deska: boolean;
}

const odst = (s: string) => `<p>${s}</p>`;
const adresa = (o: ObecProfil) =>
  [o.obec.nazev, o.obec.adresa.ulice, `${o.obec.adresa.psc} ${o.obec.adresa.mesto}`.trim()]
    .filter((x) => x.trim())
    .map(e)
    .join('<br>');
/** „Zastupitelstvo: volební období 2026–2030. …“ (prázdné, když profil obce období ani poznámku nemá) */
export function zastupitelstvoText(o: ObecProfil): string {
  const z = o.obec.zastupitelstvo;
  if (!z.volebni_obdobi && !z.poznamka) return '';
  const obdobi = z.volebni_obdobi ? `Zastupitelstvo obce, volební období ${e(z.volebni_obdobi)}.` : '';
  return odst([obdobi, e(z.poznamka)].filter(Boolean).join(' '));
}
const mail = (a: string) => `<a href="mailto:${e(a)}">${e(a)}</a>`;

/** adresa obce ve Sbírce právních předpisů územních samosprávných celků (sbirkapp.gov.cz) */
export function sbirkaPp(o: ObecProfil): string {
  if (o.obec.sbirka_pp) return o.obec.sbirka_pp;
  const ds = o.obec.kontakt.datova_schranka.trim();
  return ds ? `https://sbirkapp.gov.cz/vydavatel/${encodeURIComponent(ds)}` : 'https://sbirkapp.gov.cz/';
}

const nadrizeny = (o: ObecProfil) => (o.obec.nadrizeny_organ ? e(o.obec.nadrizeny_organ) : 'krajský úřad');

// Označení a pořadí bodů přesně podle přílohy č. 1 vyhlášky č. 515/2020 Sb. (znění ověřeno 19. 10. 2026).
// Klíče jsou stabilní (ukládají se k nim texty úřadu v tabulce pi_body) — při změně přílohy migrovat i data.
export const STRUKTURA_PI: BodPi[] = [
  { klic: '1', nazev: 'Název', uroven: 1, auto: (o) => odst(e(o.obec.nazev)) },
  {
    klic: '2',
    nazev: 'Důvod a způsob založení',
    uroven: 1,
    napoveda:
      'Vyhláška vyžaduje vždy uvést zřizovatele a nadřízený orgán (u obce krajský úřad v přenesené působnosti; adresu doplňte v profilu obce jako nadrizeny_organ).',
    vychozi: (o) =>
      odst(
        `${e(o.obec.nazev)} je územním samosprávným společenstvím občanů (veřejnoprávní korporací) podle čl. 99 a násl. Ústavy České republiky a zákona č. 128/2000 Sb., o obcích (obecní zřízení). Samostatně spravuje své záležitosti (samostatná působnost) a vykonává státní správu v rozsahu stanoveném zákony (přenesená působnost). Orgány obce jsou zastupitelstvo, starosta a obecní úřad.`,
      ) +
      `<ul><li>Zřizovatel: obec nemá zřizovatele — vznikla a existuje přímo ze zákona.</li><li>Nadřízený orgán při výkonu přenesené působnosti: ${nadrizeny(o)}.</li><li>Dozor nad výkonem samostatné působnosti: Ministerstvo vnitra (§ 123 a násl. zákona o obcích); kontrolu výkonu přenesené působnosti provádí krajský úřad (§ 129a).</li></ul>`,
  },
  {
    klic: '3',
    nazev: 'Organizační struktura',
    uroven: 1,
    napoveda:
      'Zastupitelstvo, starosta, místostarosta, výbory, zaměstnanci úřadu. Vyplní se samo ze seznamu lidí v profilu obce.',
    auto: (o) => {
      if (!o.obec.lide.length) return null;
      const skupiny = new Map<string, typeof o.obec.lide>();
      for (const c of o.obec.lide) skupiny.set(c.skupina, [...(skupiny.get(c.skupina) ?? []), c]);
      return (
        zastupitelstvoText(o) +
        [...skupiny.entries()]
          .map(
            ([s, lide]) =>
              `<h3>${e(s)}</h3><ul>${lide.map((c) => `<li>${e(c.funkce)}: ${e(c.jmeno)}</li>`).join('')}</ul>`,
          )
          .join('')
      );
    },
  },
  { klic: '4', nazev: 'Kontaktní spojení', uroven: 1, skupina: true },
  {
    klic: '4.1',
    nazev: 'Kontaktní poštovní adresa',
    uroven: 2,
    auto: (o) => (o.obec.adresa.ulice ? odst(`Sídlo:<br>${adresa(o)}`) : null),
  },
  {
    klic: '4.2',
    nazev: 'Adresa úřadovny pro osobní návštěvu',
    uroven: 2,
    napoveda: 'Pokud se liší od poštovní adresy, doplňte ji.',
    auto: (o) => (o.obec.adresa.ulice ? odst(adresa(o)) : null),
  },
  {
    klic: '4.3',
    nazev: 'Úřední hodiny',
    uroven: 2,
    auto: (o) =>
      o.obec.kontakt.uredni_hodiny.trim()
        ? odst(e(o.obec.kontakt.uredni_hodiny.trim()).replace(/\n/g, '<br>'))
        : null,
  },
  {
    klic: '4.4',
    nazev: 'Telefonní čísla',
    uroven: 2,
    napoveda: 'Telefonní čísla s mezinárodní předvolbou; vnitřní linka za lomítkem.',
    auto: (o) => {
      const t = [
        o.obec.kontakt.telefon &&
          `Obecní úřad: ${e(formatujTelefon(o.obec.kontakt.telefon) || o.obec.kontakt.telefon)}`,
      ]
        .concat(
          o.obec.lide
            .filter((c) => c.telefon)
            .map((c) => `${e(c.funkce)}: ${e(formatujTelefon(c.telefon) || c.telefon)}`),
        )
        .concat(o.obec.kontakt.fax ? [`Fax: ${e(o.obec.kontakt.fax)}`] : [])
        .filter(Boolean);
      return t.length ? odst(t.join('<br>')) : null;
    },
  },
  {
    klic: '4.5',
    nazev: 'Adresa internetových stránek',
    uroven: 2,
    auto: (o, k) => {
      const url = o.obec.kontakt.web || k.baseUrl;
      return odst(`<a href="${e(url)}">${e(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
    },
  },
  {
    klic: '4.6',
    nazev: 'Adresa podatelny',
    uroven: 2,
    napoveda:
      'Adresa pro listinné dokumenty a dokumenty na technických nosičích dat; uveďte, které nosiče úřad přijímá (např. USB flash disk, CD, DVD).',
    auto: (o) =>
      o.obec.adresa.ulice
        ? odst(`Podatelna obecního úřadu: ${adresa(o).replace(/<br>/g, ', ')}`) +
          odst(
            'Na této adrese lze v úředních hodinách podat i dokumenty v elektronické podobě na technických nosičích dat (USB flash disk, CD, DVD).',
          )
        : null,
  },
  {
    klic: '4.7',
    nazev: 'Elektronická adresa podatelny',
    uroven: 2,
    napoveda: 'E-mailová adresa podatelny; dále další elektronické adresy s účelem jejich použití.',
    auto: (o) => {
      const r = [
        o.obec.kontakt.epodatelna && `Elektronická podatelna: ${mail(o.obec.kontakt.epodatelna)}`,
        o.obec.kontakt.email &&
          o.obec.kontakt.email !== o.obec.kontakt.epodatelna &&
          `Obecní úřad: ${mail(o.obec.kontakt.email)}`,
      ]
        .concat(
          o.obec.lide
            .filter((c) => c.email && c.email !== o.obec.kontakt.epodatelna)
            .map((c) => `${e(c.funkce)}: ${mail(c.email)}`),
        )
        .filter(Boolean);
      return r.length ? odst(r.join('<br>')) : null;
    },
  },
  {
    klic: '4.8',
    nazev: 'Datová schránka',
    uroven: 2,
    auto: (o) =>
      o.obec.kontakt.datova_schranka
        ? odst(`Identifikátor datové schránky: ${e(o.obec.kontakt.datova_schranka)}`)
        : null,
  },
  {
    klic: '5',
    nazev: 'Případné platby lze poukázat',
    uroven: 1,
    napoveda:
      'Číslo účtu s kódem banky, účel platby a požadované symboly (konstantní, variabilní, specifický); jiné způsoby platby (hotově na úřadě).',
    auto: (o) => {
      const u = o.obec.bankovni_ucet;
      if (!u.cislo) return null;
      return odst(`Číslo účtu: ${e(u.cislo)}${u.iban ? `<br>IBAN: ${e(u.iban)}` : ''}`);
    },
  },
  { klic: '6', nazev: 'IČO', uroven: 1, auto: (o) => (o.obec.ico ? odst(e(o.obec.ico)) : null) },
  {
    klic: '7',
    nazev: 'Plátce daně z přidané hodnoty',
    uroven: 1,
    napoveda:
      'Plátce DPH uvede DIČ; obec, která plátcem není, uvede tuto skutečnost (v profilu obce platce_dph: true/false).',
    auto: (o) => {
      if (o.obec.platce_dph === true && o.obec.dic) return odst(`DIČ: ${e(o.obec.dic)}`);
      if (o.obec.platce_dph === false)
        return odst(
          `${e(o.obec.nazev)} není plátcem daně z přidané hodnoty.${o.obec.dic ? ` DIČ: ${e(o.obec.dic)}` : ''}`,
        );
      return null;
    },
  },
  { klic: '8', nazev: 'Dokumenty', uroven: 1, skupina: true },
  {
    klic: '8.1',
    nazev: 'Seznamy hlavních dokumentů',
    uroven: 2,
    napoveda:
      'Dokumenty koncepční, strategické a programové povahy — např. územní plán, program rozvoje obce, koncepce — s odkazy.',
  },
  {
    klic: '8.2',
    nazev: 'Rozpočet',
    uroven: 2,
    auto: (_o, k) =>
      k.deska
        ? odst(
            'Rozpočet a jeho změny (rozpočtová opatření) v aktuálním a uplynulém roce, střednědobý výhled a závěrečný účet: <a href="/rozpocet">Rozpočtová dokumentace</a>.',
          )
        : null,
  },
  {
    klic: '9',
    nazev: 'Žádosti o informace',
    uroven: 1,
    vychozi: (o, k) =>
      odst(
        `Žádost o informace podle zákona č. 106/1999 Sb. lze podat ústně nebo písemně na adrese obecního úřadu, elektronicky${o.obec.kontakt.epodatelna ? ` na adresu ${mail(o.obec.kontakt.epodatelna)}` : ''}${o.obec.kontakt.datova_schranka ? ` nebo datovou schránkou (${e(o.obec.kontakt.datova_schranka)})` : ''}. Z žádosti musí být zřejmé, kterému povinnému subjektu je určena, že se žadatel domáhá poskytnutí informace podle tohoto zákona, a kdo ji podává (u fyzické osoby jméno, příjmení, datum narození a adresa pro doručování). Obec informaci poskytne nejpozději do 15 dnů od přijetí žádosti.`,
      ) +
      odst(
        `<strong>Opravné prostředky:</strong> proti rozhodnutí o odmítnutí žádosti lze podat odvolání do 15 dnů ode dne jeho doručení (§ 16 zákona č. 106/1999 Sb., § 83 správního řádu). Stížnost na postup při vyřizování žádosti (např. informace nebyla poskytnuta v termínu nebo nesouhlasíte s výší úhrady) lze podat písemně nebo ústně do 30 dnů (§ 16a). Odvolání i stížnost se podávají u obecního úřadu, který je předloží nadřízenému orgánu (${nadrizeny(o)}); musí z nich být zřejmé, kdo je podává, proti čemu směřují a čeho se žadatel domáhá.`,
      ) +
      (k.deska
        ? odst(
            'Informace poskytnuté na žádost zveřejňujeme do 15 dnů od jejich poskytnutí nejméně po dobu 6 let (§ 5 odst. 3): <a href="/uredni-deska?kategorie=poskytnute-informace">Poskytnuté informace</a>.',
          )
        : ''),
  },
  {
    klic: '10',
    nazev: 'Příjem podání a podnětů',
    uroven: 1,
    vychozi: (o) =>
      odst(
        'Žádosti, stížnosti, návrhy, podněty a jiná podání lze učinit písemně (poštou nebo osobně na podatelně obecního úřadu v úředních hodinách), elektronicky prostřednictvím elektronické podatelny nebo datové schránky, případně ústně do protokolu. Rozhodnutí o právech a povinnostech osob si lze vyzvednout na obecním úřadě, pokud nejsou doručena jinak.',
      ) +
      odst(
        `<strong>Opravné prostředky proti rozhodnutím obce:</strong> proti rozhodnutí vydanému ve správním řízení lze podat odvolání do 15 dnů ode dne oznámení rozhodnutí, a to u obecního úřadu, který rozhodnutí vydal; o odvolání rozhoduje nadřízený orgán (${nadrizeny(o)}). Odvolání musí obsahovat údaje o tom, kdo je podává, proti kterému rozhodnutí směřuje, v jakém rozsahu ho napadá a v čem je spatřován rozpor s právními předpisy nebo nesprávnost rozhodnutí (§ 81–83 zákona č. 500/2004 Sb., správní řád). Konkrétní poučení je vždy součástí rozhodnutí; zvláštní formulář se nevyžaduje.`,
      ) +
      odst(
        'Popisy postupů (životních situací) zveřejňuje Ministerstvo vnitra na <a href="https://portal.gov.cz/">Portálu veřejné správy</a>.',
      ),
  },
  { klic: '11', nazev: 'Předpisy', uroven: 1, skupina: true },
  {
    klic: '11.1',
    nazev: 'Nejdůležitější používané předpisy',
    uroven: 2,
    vychozi: () =>
      `<ul><li>Ústava České republiky a Listina základních práv a svobod</li><li>zákon č. 128/2000 Sb., o obcích (obecní zřízení)</li><li>zákon č. 106/1999 Sb., o svobodném přístupu k informacím</li><li>zákon č. 500/2004 Sb., správní řád</li><li>zákon č. 250/2000 Sb., o rozpočtových pravidlech územních rozpočtů</li><li>zákon č. 340/2015 Sb., o registru smluv</li><li>zákon č. 99/2019 Sb., o přístupnosti internetových stránek a mobilních aplikací</li><li>zákon č. 110/2019 Sb., o zpracování osobních údajů, a nařízení (EU) 2016/679 (GDPR)</li></ul>` +
      odst(
        'Předpisy jsou přístupné k nahlédnutí na obecním úřadě v <a href="#bod-4-3">úředních hodinách</a> a kdykoli elektronicky v <a href="https://www.e-sbirka.cz/">e-Sbírce</a> (Sbírka zákonů a mezinárodních smluv).',
      ),
  },
  {
    klic: '11.2',
    nazev: 'Vydané právní předpisy',
    uroven: 2,
    auto: (o, k) =>
      odst(
        `Obecně závazné vyhlášky a nařízení obce jsou zveřejněny ve <a href="${e(sbirkaPp(o))}">Sbírce právních předpisů územních samosprávných celků</a>${k.deska ? ' a na <a href="/uredni-deska?kategorie=vyhlasky">úřední desce</a>' : ''}. K nahlédnutí jsou také na obecním úřadě v úředních hodinách.`,
      ),
  },
  { klic: '12', nazev: 'Úhrady za poskytování informací', uroven: 1, skupina: true },
  {
    klic: '12.1',
    nazev: 'Sazebník úhrad za poskytování informací',
    uroven: 2,
    napoveda:
      'Sazebník schválený obcí (např. cena za kopii stránky, za hodinu mimořádně rozsáhlého vyhledávání).',
  },
  {
    klic: '12.2',
    nazev: 'Rozhodnutí nadřízeného orgánu o výši úhrad za poskytnutí informací',
    uroven: 2,
    napoveda: 'Rozhodnutí o stížnostech proti výši úhrady (§ 16a), nejméně za poslední 2 roky.',
    vychozi: () => odst('V posledních dvou letech žádné takové rozhodnutí vydáno nebylo.'),
  },
  { klic: '13', nazev: 'Licenční smlouvy', uroven: 1, skupina: true },
  {
    klic: '13.1',
    nazev: 'Vzory licenčních smluv',
    uroven: 2,
    vychozi: () => odst('Obec vzory licenčních smluv nevydala.'),
  },
  {
    klic: '13.2',
    nazev: 'Výhradní licence',
    uroven: 2,
    vychozi: () => odst('Obec výhradní licence neposkytla.'),
  },
  {
    klic: '14',
    nazev: 'Výroční zpráva podle zákona o svobodném přístupu k informacím',
    uroven: 1,
    napoveda: 'Výroční zprávy za poslední roky (odkaz na dokumenty nebo text). Zveřejňuje se do 1. března.',
  },
];

export interface VyplnenyBod extends BodPi {
  html: string;
  stav: StavBodu | 'vlastni';
}

/** vyplní strukturu: vlastní text úřadu > z profilu obce > výchozí text > chybí */
export function vyplnPi(o: ObecProfil, vlastni: Map<string, string>, k: KontextPi): VyplnenyBod[] {
  return STRUKTURA_PI.map((b) => {
    if (b.skupina) return { ...b, html: '', stav: 'auto' as const };
    const v = vlastni.get(b.klic)?.trim();
    if (v) return { ...b, html: v, stav: 'vlastni' as const };
    const a = b.auto?.(o, k);
    if (a) return { ...b, html: a, stav: 'auto' as const };
    if (b.vychozi) return { ...b, html: b.vychozi(o, k), stav: 'vychozi' as const };
    return { ...b, html: '', stav: 'chybi' as const };
  });
}
