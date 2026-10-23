# Kontrola webu vlastiborice.cz - říjen 2026

Externí kontrola produkce `https://www.vlastiborice.cz/` a `https://vlastiborice.cz/` z 23. 10. 2026 (jen GET/HEAD
požadavky, bez přístupu na server a do správy). Kontrolovalo se, co web servíruje (stavové kódy, odkazy, přesměrování,
certifikát, hlavičky, assety, responzivita, povinný obsah obecního webu), co říká vyhledávačům a sociálním sítím
(metadata, robots, sitemap) a jazyk publikovaného textu. Bezpečnostní testy nebyly součástí kontroly.

Tenhle soubor je podklad k PR. Po vyhodnocení ho klidně smaž.

## Co v PR měním

- **Kanonická adresa a Open Graph.** Všech 224 stránek ze sitemapy bylo bez `<link rel="canonical">` a bez Open Graph.
  Web přitom odpovídá s kódem 200 na `vlastiborice.cz` i na `www.vlastiborice.cz` a na libovolný dotaz (`/?p=1`).
  Vyhledávač tak vidí celý web dvakrát. Odkaz sdílený na Facebooku nebo WhatsAppu nemá náhledový obrázek.
  Layout teď u veřejných stránek webu doplní canonical z `BASE_URL` (bez dotazu a koncového lomítka),
  `og:title/description/url/image/site_name/locale` a `twitter:card`. Jako obrázek použije úvodní fotku, jinak znak
  obce. Stránky s `noindex` (hledání, správa) a chybové stránky je nemají.
- **Sitemap.** Chyběly v ní `/odstavky` a detaily dotací `/dotace/<id>`, na které vede odkaz z titulky.
- Testy v `test/audit-souladu.test.ts`. Typecheck, lint i celá sada (326 testů) procházejí. Ověřeno, že nové testy
  bez změny padají.

## Otevřené otázky - rozhodnutí je na tobě

1. **www, nebo bez www?** Oba hosty vracejí 200 bez přesměrování. `BASE_URL`, sitemap, robots i OIDC callback
   používají `vlastiborice.cz`, ale menu, odkazy a prohlášení o přístupnosti mluví o `www.vlastiborice.cz`.
   Přihlášení z www (`/prihlaseni`) navíc pošle uživatele na holou doménu, kde už zůstane. Navrhuju 301
   z jednoho hostu na druhý na proxy před aplikací (podle hlavičky `x-served-by` to není Caddy z repa) a pak srovnat `BASE_URL`
   s textem prohlášení. Canonical z tohoto PR mezitím drží vyhledávače na `BASE_URL`.
2. **Komprese statiky.** HTML chodí gzipem, ale `styl.css` (48 kB) a `web.js` jdou bez `content-encoding`. CSS
   blokuje vykreslení. Buď to zapnout na proxy, nebo použít `preCompressed` u `@fastify/static` s `.gz`/`.br`
   soubory z buildu.
3. **Keš statiky.** `styl.css`, `web.js` a `favicon.ico` mají `max-age=86400`, přestože URL nese `?v=`. Pokud
   se všechno ze `/static` odkazuje s verzí, může mít `immutable` na rok jako `/soubory`. Neměnil jsem to, protože
   třeba `/static/img/volt-logo.svg` verzi v URL nemá.
4. **Koncové lomítko.** `/kontakt/`, `/uredni-deska/` a `/aktuality/` vracejí 404, `/obec/` vrací 200 (duplicita
   k `/obec`), `/rezervace` a `/eknihy` přesměrují na verzi s lomítkem. Navrhuju 301 na verzi bez lomítka
   (kromě podaplikací pod `/rezervace/` a `/eknihy/`).
5. **Popisky stránek.** 32 stránek (titulka, `/obec`, `/obecni-urad`, `/kontakt`, `/dotace`, `/uredni-deska`,
   stránky osad…) má stejný popisek „Obec na okraji Českého ráje“ (motto). U aktualit je to useknutý perex do
   300 znaků. Stálo by za úvahu pole „popis pro vyhledávače“ u stránky nebo aspoň texty pro stránky modulů.
6. **Duplicitní titulky.** Opakované akce (`/aktuality/sber-elektroodpadu`, `-2`, `-3`, „Hrátky s pamětí“,
   „Jarní divadelní víkend“…) mají shodný `<title>`. Přidat do titulku datum? A `/okolo-vlasti-2026-beh-pro-terezku`
   existuje jako stránka i jako aktualita, takže je možná dvakrát.
7. **Strukturovaná data.** Není žádné schema.org (`GovernmentOrganization`, `Place`, `Event` pro akce). Není to
   chyba, jen příležitost na později.
8. **Ověření ve vyhledávačích.** V DNS ani na stránce není ověření pro Google Search Console ani Seznam Webmaster.
   Ověření přes HTML soubor zvenku nevidím, takže možná už ověřený je. Po vyřešení bodu 1 doporučuju doménovou
   property v GSC (TXT záznam u poskytovatele DNS, teď ebola.cz) a odeslání sitemapy v obou nástrojích. Seznam má v indexu ještě adresy
   ze starého WordPressu. Přesměrování na nové adresy fungují, takže to doběhne samo.
9. **Pomlčky v titulcích a rozsazích.** Oddělovač v titulku je em dash („Kontakt — Obec Vlastibořice“). V češtině
   se jako oddělovač píše pomlčka s mezerami („Kontakt – Obec Vlastibořice“). Rozsahy („9:00–15:30“) jsou
   v pořádku. Je to drobnost a styl celé platformy, proto jsem na to nesahal.
10. **Patička.** Patička obecního webu nese logo a heslo Volt („Spojujeme Evropu“) s odkazem na voltcesko.org.
    Odkaz „Otevřený software (EUPL-1.2)“ vede taky tam, ne na tohle repo. Zvaž, jestli má být na oficiálním webu
    obce jen odkaz na zdrojový kód.

## Obsah k opravě ve správě webu (není v repu)

- **Povinné informace, bod 14** („Výroční zpráva…“) obsahuje jen „Informace se doplňuje.“ Výroční zprávy za
  roky 2024 a 2025 jsou v archivu úřední desky, stačí na ně odkázat. Text zprávy za rok 2025 na webu cituje
  „zákon 101/1999 Sb.“, správně je 106/1999 Sb.
- **Počty obyvatel a osad si odporují:** „Informace o obci“ uvádí 357 i 210 obyvatel a čtyři osady, titulka
  „Obyvatel 297, Osady 3“.
- **Dům s pečovatelskou službou:** kapacita 14 bytů / 16 osob / 24 osob na jedné stránce, „Informace o obci“
  uvádí 12 bytů.
- **Stránky osad** `/obec/vlastiborice`, `/obec/jivina`, `/obec/sedlistka`, `/obec/slavikov` jsou prázdné, ale
  ukazují „Stránka aktualizována 19. 10. 2026“.
- **Text odkazu = název souboru:** „zadost“ (DPS), „priloha_1784615582_1_Upozornění k odstranění a okle…“ (ČEZ).
- **Velké obrázky:** `verejne-osvetleni.png` (192 kB) a `banner-hriste.png` (155 kB) jsou fotky v PNG. Jako JPG
  nebo WebP by byly zlomkem velikosti. Titulka má při 1200 px kolem 1,3 MB.
- **Jazyk** (výběr; o úplný seznam si řekni):
  - „Obec Vlastibořice, se svými čtyřmi osadami: … reprezentující typicky venkovské osídlení leží…“: rozbitá
    věta. Návrh: „Obec Vlastibořice se čtyřmi osadami (Vlastibořice, Jivina, Sedlíšťka a Slavíkov), které mají
    venkovský ráz, leží…“
  - „…určeny státním archeologickým ústavem vyplývá“: chybí čárka před „vyplývá“.
  - „Po odsunu Němců ze Sudet, došlo…“: čárka navíc.
  - „Ještědskokozákovského hřbetu“ → „Ještědsko-kozákovského hřbetu“.
  - „80km“, „20km“ → „80 km“, „20 km“. „(-0,2%)“ → „(−0,2 %)“. „7.11.2026“ → „7. 11. 2026“.
  - „Předprodej … proběhne na OÚ ve dne 26. 10.“ → „ve dnech“.
  - „Časté dojíždění … jsou … vyčerpávající“ → „je“. „z důvodu nedostačující kapacity“ → „nedostatečné“.
  - „zákona č. 240/2000 Sb., o krizovém řízení o změně některých zákonů“ → „…a o změně některých zákonů“.
    „nějaké událostí“ → „události“. „(dále jen „krizový stav„)“: chybná uzavírací uvozovka.
  - „ČEZ DISTRIBUCE“ → „ČEZ Distribuce“. „Ing. Arch.“ → „Ing. arch.“
  - Na titulce (perexy aktualit, karty akcí a odstávek) chybí nezlomitelná mezera po jednopísmenných předložkách
    („v 9:25“, „k odstranění“). V detailu článků je v pořádku, takže jde nejspíš o zkracování perexu.

## Co je v pořádku

HTTPS (Let's Encrypt, obě jména, platný řetěz) a přesměrování http → https. Skutečná 404. Žádný rozbitý odkaz
z 300+ kontrolovaných (titulka, sitemap, úřední deska, povinné informace, vyhlášky). Žádný zbytek dema ani staging
adresa. `lang="cs"`, všechny obrázky mají `alt`, jeden `h1` na stránku, bez vodorovného posunu na 400 px. Prohlášení
o přístupnosti, úřední deska s archivem a RSS. Povinné informace podle vyhl. 515/2020 Sb. (kromě bodu 14).
Bez cookies třetích stran, takže lišta není potřeba. Přesměrování starých WordPress adres. robots.txt a sitemap
(225 adres, všechny 200).
