// Role úřadu na JEDNOM místě: název, popis, co přesně otevírají a která práva zahrnují.
// Nová role = položka tady + hodnota v typu Role (src/db/types.ts) + migrace omezení uzivatele_role_check.
// Texty jsou záměrně tady, ne v src/i18n/cs.ts: popis role je zároveň specifikace oprávnění (stránka
// Administrace → Systém → Role) a má ležet vedle odvozených práv, aby se nerozešly. Popisy musí odpovídat kódu —
// při změně ochrany rout (vyzadujRoli/maRoli) upravte i tento seznam.
import type { Role } from '../../db/types.js';

export interface DefiniceRole {
  id: Role;
  /** krátký název (zaškrtávátka, seznamy) */
  nazev: string;
  /** jedna věta: k čemu role je */
  popis: string;
  /** co role konkrétně otevírá v administraci (bez odvozených práv — ta říká `zahrnuje`) */
  opravneni: string[];
  /** role, jejichž práva tahle role automaticky dostává (počítá se tranzitivně) */
  zahrnuje: Role[];
  /** účet s touto rolí je chráněný: upravit ho, zablokovat, měnit mu role či kontakty smí jen tato role */
  chranena?: boolean;
}

/** pořadí = pořadí na stránce Role i v detailu účtu (od nejvyšší) */
export const DEFINICE_ROLI: readonly DefiniceRole[] = [
  {
    id: 'provozovatel',
    nazev: 'Bůh — provozovatel',
    popis:
      'Provozovatel instalace: vše jako administrátor a navíc vzhled webu a správa rolí. Účet je chráněný.',
    opravneni: [
      'Vzhled webu: barevné schéma, písma, velikost, znak, fotky pozadí, umístění počasí, náhled a vrácení zpět',
      'Přidělování a odebírání role provozovatel (jiné role přiděluje i administrátor)',
      'Přidávání a odebírání členů rolí na stránce Role',
      'Úpravy, blokace, role a schvalování změn telefonu u chráněných účtů (s rolí provozovatel)',
      'Smí měnit i vlastní role; svou roli provozovatel odebrat jen tehdy, když zůstane jiný provozovatel',
      'Napojeným aplikacím (rezervace, e-knihy) se hlásí i jako administrátor',
    ],
    zahrnuje: ['admin'],
    chranena: true,
  },
  {
    id: 'admin',
    nazev: 'administrátor',
    popis: 'Vše kromě vzhledu webu a správy role provozovatel.',
    opravneni: [
      'Přidělování rolí v detailu účtu (kromě role provozovatel; vlastní role si neměnit)',
      'Moduly obce — zapínání a vypínání modulů a napojených aplikací',
      'API a integrace — tokeny pro programy, které na web zapisují',
      'Přihlašovací klienti (OIDC) — přehled napojených aplikací',
      'Aktivace posilovny ve Schvalování',
      'Audit rezervací (odkaz do aplikace Rezervace)',
      'Blokace účtů jiných administrátorů',
    ],
    zahrnuje: ['spravce', 'web', 'deska', 'redaktor', 'kviz', 'ucetni', 'vstupne', 'knihovnice'],
  },
  {
    id: 'spravce',
    nazev: 'správce obce',
    popis: 'Vše obsahové (web, úřední deska, hlášení) a agenda účtů občanů.',
    opravneni: [
      'Uživatelé: seznam a detail účtů, blokace (ne administrátorů a chráněných účtů), zrušení zámku přihlášení',
      'Schvalování: žádosti o rezervace, posouzení rezidenta, doplnění jména',
      'Změny přihlašovacího telefonu (schválení a zamítnutí)',
      'Statistiky a audit log',
      'Elektronická podatelna (podání obsahují osobní údaje)',
      'Úřední deska: okamžité sejmutí, koš, kategorie, povinně zveřejňované informace, vyvěšení se zpětným datem',
      'Web: kategorie aktualit a přesměrování starých adres',
      'Kvíz: statistiky hráčů a ruční otázky',
      'Přehled SMS (denní limit kódů a fronta rozesílky)',
      'Dlaždice aplikace Rezervace (věci a prostory, rezervace, uživatelé, spolujízda, předprodej, finance)',
      'Avíza e-mailem: nové účty k posouzení, výstrahy, neznámé příchozí SMS, vyčerpaný limit SMS',
      'Role na stránce Role vidí jen ke čtení',
    ],
    zahrnuje: ['web', 'deska', 'redaktor'],
  },
  {
    id: 'web',
    nazev: 'redaktor webu',
    popis: 'Obsah webu: stránky, aktuality, akce, galerie, dokumenty, dotace, videa.',
    opravneni: [
      'Stránky, aktuality a akce včetně konceptů, revizí a koše',
      'Fotogalerie, dokumenty ke stažení, dotace (pás dárců), videa',
      'Kontakt obce, akce ke zpracování z rezervací',
      'Fronta textu dokumentů (vyhledávání v PDF)',
      'Kvíz: přehled otázek, import balíků, zapínání a vypínání otázek',
      'Odkaz „upravit“ přímo na stránkách webu',
    ],
    zahrnuje: [],
  },
  {
    id: 'deska',
    nazev: 'úřední deska',
    popis: 'Vyvěšování dokumentů na úřední desku a rozpočtových dokumentů.',
    opravneni: [
      'Úřední deska: nový dokument, úpravy, přílohy, lhůty vyvěšení',
      'Neveřejné přílohy dokumentů',
      'Fronta textu dokumentů (vyhledávání v PDF)',
    ],
    zahrnuje: [],
  },
  {
    id: 'redaktor',
    nazev: 'hlášení',
    popis: 'Posílá hlášení obce infokanálem (SMS a e-maily).',
    opravneni: [
      'Infokanál: nová hlášení, odběratelé, historie rozesílek',
      'Výstrahy (ČHMÚ, odstávky) — rozeslání a přehled',
      'Rozeslání zveřejněné aktuality nebo akce infokanálem (s rolí redaktor webu)',
    ],
    zahrnuje: [],
  },
  {
    id: 'knihovnice',
    nazev: 'knihovnice',
    popis: 'Příspěvky obecní knihovny: aktuality v rubrice knihovny a jejích podrubrikách.',
    opravneni: [
      'Aktuality v rubrice knihovny (profil obce web.rubrika_knihovny, výchozí „knihovna“) a jejích podrubrikách: psaní, úpravy, koncepty, revize, skrytí a smazání do koše',
      'Obrázky a soubory do textu příspěvku',
      'Ostatní obsah webu ani jiné rubriky nevidí; další rubriky příspěvku, které nespravuje, zůstávají beze změny',
    ],
    zahrnuje: [],
  },
  {
    id: 'kviz',
    nazev: 'kvíz',
    popis: 'Správa kvízu o obci.',
    opravneni: ['Přehled otázek, import balíků, zapínání a vypínání otázek'],
    zahrnuje: [],
  },
  {
    id: 'ucetni',
    nazev: 'účetní',
    popis: 'Platby a vyúčtování v aplikaci Rezervace.',
    opravneni: [
      'Dlaždice Finance v Administraci: vyúčtování, report, ceník, předprodej, uživatelé rezervací',
      'Samotná práva v aplikaci Rezervace přiděluje aplikace podle této role',
    ],
    zahrnuje: [],
  },
  {
    id: 'vstupne',
    nazev: 'vstupné',
    popis: 'Kontrola vstupenek u dveří (stránka Vstup v aplikaci Rezervace).',
    opravneni: ['Vstup do Administrace (bez dalších dlaždic); stránku Vstup otevírá aplikace Rezervace'],
    zahrnuje: [],
  },
];

const PODLE_ID = new Map<Role, DefiniceRole>(DEFINICE_ROLI.map((d) => [d.id, d]));

export function definiceRole(id: Role): DefiniceRole | undefined {
  return PODLE_ID.get(id);
}

/** všechna práva účtu: vlastní role + tranzitivně zahrnuté */
export function efektivniRole(role: readonly Role[] | null | undefined): Set<Role> {
  const vysledek = new Set<Role>();
  const fronta = [...(role ?? [])];
  while (fronta.length) {
    const r = fronta.pop()!;
    if (vysledek.has(r)) continue;
    vysledek.add(r);
    fronta.push(...(PODLE_ID.get(r)?.zahrnuje ?? []));
  }
  return vysledek;
}

/** role, které dědí práva dané role (např. web ← spravce ← admin ← provozovatel) */
export function roleSPravem(id: Role): Role[] {
  return DEFINICE_ROLI.filter((d) => d.id !== id && efektivniRole([d.id]).has(id)).map((d) => d.id);
}

/** chráněné role (účet s nimi mění jen jejich držitel) */
export const CHRANENE_ROLE: readonly Role[] = DEFINICE_ROLI.filter((d) => d.chranena).map((d) => d.id);

/** role pro napojené aplikace (OIDC claims, interní API): provozovatel se jim hlásí i jako admin */
export function roleProAplikace(role: readonly Role[]): Role[] {
  return role.includes('provozovatel') && !role.includes('admin') ? [...role, 'admin'] : [...role];
}
