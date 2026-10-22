# Akce: propojení rezervace, kalendáře, pozvánky a rozesílky (návrh 22. 10. 2026)

## Cíl

Jedna společenská akce (koncert v sále, turnaj na hřišti, jóga každý čtvrtek) má dnes až čtyři podoby, které spolu
nevědí: **rezervace** v rezervačním systému, **položka v kalendáři** `/akce`, **pozvánka** (článek v Aktualitách,
typicky „Obec informuje“ nebo „Kultura a akce“) a **rozesílka** infokanálem. Cíl: jedna akce = jeden záznam
na webu, ke kterému se ostatní podoby připojí — a nezáleží na tom, co vznikne dřív.

## Model

- Ústředním bodem je **záznam obsahu typu `akce`** (`web_obsah`, už dnes má datum, konec, celý den, místo,
  text, obrázek, kategorii a `hlaseni_id`).
- Nový sloupec `web_obsah.rezervace_ref` (text, unikátní mezi nesmazanými): odkaz na termín v rezervačním
  systému v podobě, jakou vrací kalendářní API — `r<id>` (jedna rezervace), `s<id>` (celá opakovaná série),
  `e<id>` (akce předprodeje). API rezervací musí u položek série posílat id série (dnes `serie`).
- Nový sloupec `web_obsah.v_aktualitach` (boolean): akce se ukáže i v Aktualitách jako **pozvánka** (pod svou
  kategorií, s datem zveřejnění); kalendář ji řadí podle data konání. Jeden záznam = kalendář i pozvánka,
  žádná kopie textu.
- Rozesílka: `web_obsah.hlaseni_id` (už existuje) — u záznamu se zobrazí „Rozesláno <datum>, <n> příjemcům“.

## Toky

1. **Nejdřív rezervace.** Synchronizace kalendáře (při každém načtení API, keš 10 min, plus cron) pro každou
   veřejnou rezervaci bez propojení:
   - když najde nepropojenou akci na webu ve **stejný den** s podobným názvem nebo časem (normalizovaný název
     bez diakritiky, shoda slov / časový překryv) → nic nezakládá, ale ve správě nabídne „Propojit s: …“;
   - jinak založí **koncept** akce (nikdy rovnou zveřejněný) s názvem, termínem, místem (zdroj) a odkazem
     (`rezervace_ref`), autor „systém“. Koncept vidí redaktor v seznamu **„Akce ke zpracování“** ve správě webu.
   - Redaktor: doplní text a fotku a zveřejní / propojí s existující akcí (koncept jde do koše, ref přejde)
     / označí „jen v kalendáři“ (koncept do koše, ref se zapamatuje v `web_akce_ignorovane`, aby nevznikal znovu).
   - Nastavení obce `web.akce_koncepty: true|false` (výchozí true).
2. **Nejdřív pozvánka.** V editoru akce pole **„Propojit s rezervací“**: výběr z nadcházejících veřejných
   rezervací, které ještě nejsou propojené (název, datum, čas, zdroj). Až rezervace vznikne později, krok 1 ji
   najde podle shody a nabídne propojení (nezaloží duplicitní koncept).
3. **Kalendář `/akce` a úvod:** externí položka s `ref`, který je propojený se **zveřejněnou** akcí, se
   nezobrazuje — místo ní akce z webu (odkaz `/akce/<slug>`). Nepropojené externí položky dál jako dnes.
   Série: jedna akce pro celou sérii, text opakování z API.
4. **Změna v rezervacích:** když se termín propojené rezervace změní (datum/čas z API ≠ akce) nebo rezervace
   zmizí (zrušena), seznam „Akce ke zpracování“ to ukáže („Termín v rezervacích se změnil na …“ / „Rezervace
   zrušena“) s tlačítkem „Převzít termín“. Web se sám nemění — rozhoduje redaktor.
5. **Rozesílka z příspěvku:** u každé zveřejněné aktuality i akce ve správě tlačítko **„Rozeslat infokanálem“**
   → formulář nového hlášení předvyplněný (předmět = titulek, e-mail = perex + odkaz, SMS = krátký text + odkaz,
   kategorie „Obecná hlášení“ / u akcí „Pozvánky“, je-li), po odeslání `hlaseni_id` u příspěvku. Opačný směr
   (hlášení → článek) už existuje.

## Úvodní statistiky

Každé číslo je odkaz: fakta z `obec.yml` mají nepovinné `odkaz` (obyvatel → `/ucet`, osady →
`/obec/informace-o-obci`); úřední deska → `/uredni-deska`; odběratelé → `/infokanal`; zprávy za měsíc =
počet aktualit kategorie z `web.stat_zpravy_kategorie` (Vlastibořice `obecni-urad`) s odkazem na
`/aktuality?kategorie=…`; nadmořská výška u Vlastibořic vypuštěna, místo ní **pět** nejbližších akcí,
každá odkazuje na svou akci (`/akce/<slug>`, jinak na `/akce`).

## Rozhodnutí při implementaci (22. 10. 2026)

- **Migrace 0014** přidává kromě `rezervace_ref`, `v_aktualitach` a `web_akce_ignorovane` ještě sloupec
  **`web_obsah.rezervace_termin`** — podpis termínu z rezervací v okamžiku propojení / převzetí. Změna se hlásí,
  když se podpis v API liší od uloženého, ne když se liší od data akce: redaktor smí na webu záměrně uvést jiný čas
  (např. otevření sálu). Tlačítko **„Ponechat termín na webu“** změnu vezme na vědomí (uloží nový podpis).
- **Série:** podpis = den v týdnu + čas (nejbližší výskyt se posouvá každý týden, to změna není). V kalendáři
  a na úvodu se propojená zveřejněná akce série ukazuje s nejbližším výskytem a textem opakování z rezervací, na
  detailu akce taky; mezi proběhlými se neukazuje, dokud série v rezervacích běží.
- **Jednorázová propojená akce** se v kalendáři ukazuje s termínem z webu (rozhoduje redaktor).
- **Zrušená rezervace** = propojený termín v API chybí, zdroj při posledním stažení odpověděl a akce ještě
  neproběhla. Nabízí se „Odpojit od rezervace“; akce sama se nikdy nemaže ani neskrývá.
- **Koncepty ze synchronizace** (zdroj `rezervace`, nikdy nezveřejněné) si změnu termínu v rezervacích převezmou
  samy — na webu ještě nejsou. Koncept smazaný ručně do koše se znovu nezakládá (odkaz zůstává u záznamu v koši);
  při obnově z koše, kdy termín mezitím propojila jiná akce, se obnovená akce odpojí. „Jen v kalendáři“ jde ve
  správě vrátit („zpracovat znovu“).
- **Propojení v editoru** platí hned po uložení (i u rozpracované změny zveřejněné akce) — není součástí konceptu
  ani revizí; zatržítko „Zobrazit i v Aktualitách“ součástí konceptu je (projeví se až zveřejněním). Akce dostala
  v editoru i výběr **kategorie** (pozvánka se řadí pod ni v Aktualitách).
- **Shoda pro návrh propojení:** stejný den (u vícedenní akce kterýkoli její den) a buď společné slovo názvu
  (aspoň 4 znaky, bez diakritiky) / jeden název obsahuje druhý, nebo překryv času (jen když obě mají konkrétní
  čas; bez konce se počítá 2 h). Celodenní termín se páruje jen podle názvu.
- **Vypnuté koncepty** (`web.akce_koncepty: false`): termíny bez akce se ve správě vypíšou s tlačítky „Založit
  akci“ a „Jen v kalendáři“.
- **Rozesílka z příspěvku:** kategorie akce = první existující ze slugů `pozvanky`, `kultura`, `hlaseni`;
  aktuality `hlaseni`. Pole pro článek se při rozesílce příspěvku nezobrazují (článek už je). Při opakované
  rozesílce se u příspěvku zapíše poslední hlášení. SMS se zkracuje na 1 SMS i s předponou obce a odkazem.
- **Statistiky:** popisek zpráv za měsíc zůstal „zpráv za poslední měsíc“ i při kategorii (cíl odkazu ukazuje,
  o jakou kategorii jde). Dlaždice je jeden odkaz `<a>` s popiskem i číslem (seznam `<ul>` místo `<dl>`).
