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
