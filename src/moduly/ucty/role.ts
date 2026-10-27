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
  /** roli přiděluje a odebírá jen Superadmin (provozovatel) — Admin ne */
  jenSuperadmin?: boolean;
}

/** pořadí = pořadí na stránce Role i v detailu účtu (od nejvyšší) */
export const DEFINICE_ROLI: readonly DefiniceRole[] = [
  {
    id: 'provozovatel',
    nazev: 'Superadmin',
    popis:
      'Provozovatel instalace: vše jako Admin a navíc přidělování rolí Admin a Superadmin. Účet je chráněný.',
    opravneni: [
      'Přidělování a odebírání rolí Superadmin a Admin (ostatní role přiděluje i Admin)',
      'Přidávání a odebírání členů rolí na stránce Role (i dočasně, s datem „platí do“)',
      'Úpravy, blokace, role a schvalování změn telefonu u chráněných účtů (s rolí Superadmin)',
      'Smí měnit i vlastní role; svou roli Superadmin odebrat jen tehdy, když zůstane jiný Superadmin',
      'Napojeným aplikacím (rezervace, e-knihy) se hlásí i jako Admin',
    ],
    zahrnuje: ['admin'],
    chranena: true,
    jenSuperadmin: true,
  },
  {
    id: 'admin',
    nazev: 'Admin',
    popis: 'Vše kromě přidělování rolí Admin a Superadmin.',
    opravneni: [
      'Vzhled webu: barevné schéma, písma, velikost, znak, fotky pozadí, umístění počasí, náhled a vrácení zpět',
      'Přidělování rolí v detailu účtu, i dočasně s datem „platí do“ (kromě rolí Admin a Superadmin; vlastní role si neměnit)',
      'Moduly obce — zapínání a vypínání modulů a napojených aplikací',
      'API a integrace — tokeny pro programy, které na web zapisují',
      'Přihlašovací klienti (OIDC) — přehled napojených aplikací',
      'Aktivace posilovny ve Schvalování',
      'Audit rezervací (odkaz do aplikace Rezervace)',
      'Blokace účtů jiných Adminů',
      'Přihlášená zařízení účtů a odhlášení na dálku (detail účtu)',
      'Stav systému — verze, migrace, SMS brána, e-mail, fronty, databáze a zálohy (jen čtení)',
      'Dostává e-mail, když někdo získá roli Admin nebo Superadmin',
    ],
    zahrnuje: ['spravce', 'web', 'deska', 'redaktor', 'kviz', 'ucetni', 'vstupne', 'knihovnice'],
    jenSuperadmin: true,
  },
  {
    id: 'spravce',
    nazev: 'Správce obce',
    popis: 'Vše obsahové (web, úřední deska, hlášení) a agenda účtů občanů.',
    opravneni: [
      'Uživatelé: seznam a detail účtů, blokace (ne Adminů a chráněných účtů), zrušení zámku přihlášení',
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
      'Role na stránce Role vidí jen ke čtení: matice oprávnění, členové s poslední aktivitou, historie změn rolí',
    ],
    zahrnuje: ['web', 'deska', 'redaktor'],
  },
  {
    id: 'web',
    nazev: 'Redaktor webu',
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
    nazev: 'Úřední deska',
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
    nazev: 'Hlášení obce',
    popis: 'Posílá hlášení obce infokanálem (SMS a e-maily).',
    opravneni: [
      'Infokanál: nová hlášení, odběratelé, historie rozesílek',
      'Výstrahy (ČHMÚ, odstávky) — rozeslání a přehled',
      'Rozeslání zveřejněné aktuality nebo akce infokanálem (s rolí Redaktor webu)',
    ],
    zahrnuje: [],
  },
  {
    id: 'knihovnice',
    nazev: 'Knihovnice',
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
    nazev: 'Kvíz',
    popis: 'Správa kvízu o obci.',
    opravneni: ['Přehled otázek, import balíků, zapínání a vypínání otázek'],
    zahrnuje: [],
  },
  {
    id: 'ucetni',
    nazev: 'Účetní',
    popis: 'Platby a vyúčtování v aplikaci Rezervace.',
    opravneni: [
      'Dlaždice Finance v Administraci: vyúčtování, report, ceník, předprodej, uživatelé rezervací',
      'Samotná práva v aplikaci Rezervace přiděluje aplikace podle této role',
    ],
    zahrnuje: [],
  },
  {
    id: 'vstupne',
    nazev: 'Vstupenkář',
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

/** role, které přiděluje a odebírá jen Superadmin (provozovatel): admin a provozovatel */
export const ROLE_JEN_SUPERADMIN: readonly Role[] = DEFINICE_ROLI.filter((d) => d.jenSuperadmin).map(
  (d) => d.id,
);

/** chráněné role (účet s nimi mění jen jejich držitel) */
export const CHRANENE_ROLE: readonly Role[] = DEFINICE_ROLI.filter((d) => d.chranena).map((d) => d.id);

/** role pro napojené aplikace (OIDC claims, interní API): Superadmin (provozovatel) se jim hlásí i jako admin */
export function roleProAplikace(role: readonly Role[]): Role[] {
  return role.includes('provozovatel') && !role.includes('admin') ? [...role, 'admin'] : [...role];
}

/**
 * Oblast administrace pro matici oprávnění (stránka Role): které role ji otevírají (stačí jedna, včetně odvozených
 * práv — počítá se přes efektivniRole stejně jako ve vyzadujRoli). `cesta` = stránka, kterou oblast chrání:
 * test/role-system.test.ts každou cestu projde s každou rolí a ověří, že server pustí přesně ty, které tu jsou —
 * matice se tak nemůže rozejít se skutečnou ochranou rout. Oblasti bez cesty (akce ve formuláři, aplikace za proxy)
 * hlídají jiné testy.
 */
export interface OblastSpravy {
  nazev: string;
  role: readonly Role[];
  cesta?: string;
  /** oblast patří zapínatelnému modulu obce (bez něj v matici chybí) */
  modul?: string;
}

export const OBLASTI_SPRAVY: readonly OblastSpravy[] = [
  {
    nazev: 'Vstup do Administrace',
    role: ['spravce', 'ucetni', 'redaktor', 'web', 'deska', 'kviz', 'vstupne', 'knihovnice'],
    cesta: '/sprava',
  },
  { nazev: 'Aktuality a příspěvky', role: ['web', 'knihovnice'], cesta: '/sprava/web', modul: 'web' },
  {
    nazev: 'Stránky, galerie, dokumenty, dotace, videa',
    role: ['web'],
    cesta: '/sprava/web/stranky',
    modul: 'web',
  },
  {
    nazev: 'Kategorie aktualit a přesměrování',
    role: ['spravce'],
    cesta: '/sprava/web/kategorie',
    modul: 'web',
  },
  { nazev: 'Vzhled webu', role: ['admin'], cesta: '/sprava/web/vzhled', modul: 'web' },
  { nazev: 'Úřední deska', role: ['deska'], cesta: '/sprava/deska', modul: 'deska' },
  {
    nazev: 'Kategorie desky a povinně zveřejňované informace',
    role: ['spravce'],
    cesta: '/sprava/povinne-informace',
    modul: 'deska',
  },
  {
    nazev: 'Infokanál — hlášení a odběratelé',
    role: ['redaktor'],
    cesta: '/infokanal/sprava',
    modul: 'infokanal',
  },
  { nazev: 'Výstrahy', role: ['redaktor'], cesta: '/infokanal/sprava/vystrahy', modul: 'infokanal' },
  { nazev: 'Kvíz — otázky a balíky', role: ['kviz', 'web'], cesta: '/sprava/kviz', modul: 'kviz' },
  { nazev: 'Kvíz — hráči a ruční otázky', role: ['spravce'], cesta: '/sprava/kviz/hraci', modul: 'kviz' },
  { nazev: 'Elektronická podatelna', role: ['spravce'], cesta: '/sprava/podatelna', modul: 'podatelna' },
  { nazev: 'Uživatelé a jejich detail', role: ['spravce'], cesta: '/sprava/uzivatele' },
  { nazev: 'Schvalování a statistiky', role: ['spravce'], cesta: '/sprava/schvalovani' },
  { nazev: 'Změny přihlašovacího telefonu', role: ['spravce'], cesta: '/sprava/ucty/zmeny-telefonu' },
  { nazev: 'Audit log', role: ['spravce'], cesta: '/sprava/audit' },
  { nazev: 'Role — přehled a historie změn', role: ['spravce'], cesta: '/sprava/role/historie' },
  { nazev: 'Přidělování rolí v detailu účtu', role: ['admin'] },
  { nazev: 'Přihlášená zařízení účtů a odhlášení na dálku', role: ['admin'] },
  { nazev: 'Členové rolí na stránce Role', role: ['provozovatel'] },
  { nazev: 'Moduly obce', role: ['admin'], cesta: '/sprava/moduly' },
  { nazev: 'API a integrace', role: ['admin'], cesta: '/sprava/api' },
  { nazev: 'Přihlašovací klienti (OIDC)', role: ['admin'], cesta: '/sprava/klienti' },
  { nazev: 'Stav systému', role: ['admin'], cesta: '/sprava/system' },
  { nazev: 'Finance v aplikaci Rezervace', role: ['spravce', 'ucetni'] },
  { nazev: 'Kontrola vstupenek (Rezervace → Vstup)', role: ['vstupne'] },
];

/** smí role (se všemi odvozenými právy) do oblasti? */
export function roleSmiOblast(role: Role, o: OblastSpravy): boolean {
  const e = efektivniRole([role]);
  return o.role.some((r) => e.has(r));
}
