# Stav projektu — etapa 1 (18. 10. 2026)

## Odstávky elektřiny ČEZ na titulce (21. 10. 2026)

- Nový modul `odstavky` (`moduly.odstavky`, `odstavky.cez.kod_obce`/`odkaz` v `obec.yml`), popis v `docs/MODULY.md`:
  karta s plánovanými odstávkami pod rychlými odkazy titulky (bez odstávky nic) a stránka `/odstavky` s historií
  30 dní. Text místo obrázkového banneru ČEZ, nic z cizích domén v prohlížeči; data stahuje server 1× za hodinu,
  po 429 pauza 3 h, při výpadku poslední známá data s časem ověření.
- Ověření: `test/odstavky.test.ts` (9 testů: převod API z reálné odpovědi, souhrn míst, pražský čas vč. konce letního
  času, keš/429/chyba/restart, historie, titulka s odstávkou a bez ní, `/odstavky`), celkem 325; axe-core 0 porušení
  na `/` a `/odstavky` (dev, s reálnou odstávkou 6. 11. 2026).

## Kvíz (21. 10. 2026)

- **Doplněno 21. 10. 2026 odpoledne:** odkazy „Skóre po oblastech“ a „Resetovat skóre“ v boxu skóre v jednom řádku
  (flex; reset je obyčejný odkaz na potvrzovací stránku). Jen pro **správce obce** (role `spravce`, admin; ne `kviz`
  ani `web`): `/sprava/kviz/hraci` — počty hráčů (celkem, s účtem, anonymní, aktivní za 7/30 dní) a tabulka hráčů
  (přezdívka účtu / „anonymní hráč #číslo“, odpovědi, skóre celkem a od resetu, nejčastější a nejsilnější oblast,
  naposledy hrál; řazení `?radit=&smer=`, stránkování po 50; žádné kontakty) a **ruční otázky** `/sprava/kviz/nova`,
  `/sprava/kviz/otazka/<id>/upravit`, export `/sprava/kviz/<kategorie>/rucne.yml` (migrace 0012: `kviz_otazky.rucne`,
  `kviz_hraci.cislo`). Testy `test/kviz.test.ts` 35, celkem 299; axe 0 porušení na 10 stránkách kvízu a správy.

- Nový modul `kviz` (zapíná se `moduly.kviz` v `obec.yml`), popis a algoritmus řazení otázek v `docs/MODULY.md`.
  Veřejně `/kviz` (výběr oblastí, otázka s oblastí a průběžným skóre, výsledek s vysvětlením a zdrojem, skóre po
  oblastech celkem i od resetu, reset s potvrzením), správa `/sprava/kviz` (nová role `kviz`, nebo `web`).
- Hrát může i nepřihlášený (cookie `mo_kviz` až po „Začít kvíz“); po přihlášení se anonymní skóre připojí k účtu.
- Otázky z YAML: `kviz-otazky/` (veřejné) + `KVIZ_BALIKY` (obec, na pilotní instalaci adresář mimo repozitář namapovaný do `/app/kviz-instance`
  → `/app/kviz-instance`). Testy používají vlastní malý balík `test/fixtures/kviz/` (vymyšlená data).
- Ověření: `test/kviz.test.ts` (28 testů), celkem 292; axe-core 0 porušení na 10 stránkách (úvod, otázka, výsledek,
  skóre, reset, A++ na mobilu, přihlášený úvod, správa). Na titulku se dlaždice nepřidala (rychlé odkazy mají
  přesně 6 sloupců) — kvíz je v menu Moje obec.
- Zbývá: úklid starých anonymních hráčů, soutěž/žebříček (záměrně ne), vlastní balík obce (místní otázky).

## Dokončení code review (19. 10. 2026)

Zbylé body externího code review (předchozí opravy jsou v CHANGELOG.md):

- **Zámek přihlášení heslem** (S5): čítač chyb v DB (migrace 0010, `prihlaseni_zamky`) podle e-mailu — neexistující
  adresa se chová stejně jako existující. Po 5 chybách 15 min, každá další chyba po vypršení zámek zdvojnásobí
  (max. 24 h), úspěch čítač nuluje, po 24 h klidu se zapomene. Ověření heslem před citlivou změnou má vlastní čítač
  podle účtu. Přihlášení SMS kódem zámek neblokuje. Audit `prihlaseni.zamceno`; správce vidí zámek v detailu účtu
  a zruší ho (`sprava.odemceni_prihlaseni`).
- **Úřední deska — náhled „co se sejme“:** rozpočtový dokument, který by sejmul dosud vyvěšené dokumenty, se nejdřív
  vrátí do formuláře se seznamem a zaškrtávacím potvrzením (bez JS). Přílohy z prvního kroku se neztratí.
- **Dashboard správy:** SMS s kódy za 24 h vůči `SMS_DENNI_LIMIT_KODU`, upozornění na vyčerpaný rozpočet a stav
  fronty infokanálu (čeká / odesílá se / odesláno a vzdáno za 24 h) — jen správce/admin, jen počty.
- **Refaktor bez změny chování:** `import/importer.ts` → `pomucky.ts`, `kontext.ts`, `media.ts`, `prepis-html.ts`,
  `sekce/*.ts`; `web/sprava-dalsi.ts` → `web/sprava-dalsi/*.ts`; `web/obsah.ts` → `obsah-pole.ts`, `obsah-cteni.ts`,
  `obsah.ts` (zápis); kratší `prepisHtml`, `ObsahSluzba.uloz`, `ctiFormular`.
- **CI:** pokrytí testy s prahy (řádky 84, příkazy 80, funkce 82, větve 68 %; naměřeno 87,9 / 84,0 / 85,7 / 72,3 %),
  `npm audit --audit-level=high` (aktualizace @fastify/static 10, nodemailer 10, vitest 4), Playwright smoke test
  (`e2e/`, samostatný job jen na push do main). Postupy v `docs/VYVOJ.md`.
- Migrace 0008: `premapujPiBody` je díky značce v `nastaveni` bezpečné zavolat znovu.
- Testy: 264 (Vitest) + 1 e2e.

## Opravy podle auditu souladu (19. 10. 2026)

- **Povinné informace** přesně podle přílohy č. 1 vyhl. 515/2020 Sb. (ověřeno na zakonyprolidi.cz): názvy a pořadí bodů, bod 2 se zřizovatelem a nadřízeným orgánem (`obec.nadrizeny_organ`), 4.1 „Sídlo“, 4.6 podatelna s nosiči dat, 7 plátce DPH (`obec.platce_dph`; neuvedeno = chybí), opravné prostředky v bodech 9 a 10 (§ 5 odst. 1 písm. c), 11.1 kde a kdy k nahlédnutí, 11.2 Sbírka právních předpisů (`obec.sbirka_pp`, jinak `sbirkapp.gov.cz/vydavatel/<DS>`; Vlastibořice `de2bjp2` ověřeno), 12.2 rozhodnutí o úhradách. Migrace 0008 přečíslovala texty úřadu 4.5–4.8.
- **Prohlášení o přístupnosti:** stav a data z `obec.yml` → `pristupnost` (výchozí „částečně“), Nepřístupný obsah s náhradním řešením, podnět § 9, dozor DIA. Vlastní text obce (`prohlaseni-o-pristupnosti-obec`) dál přebíjí šablonu.
- **Cookies:** `mo_sezeni` vzniká jen na stránce s formulářem (CSRF token se vytváří líně při vypsání); text `/zasady-cookies` v pilotu upraven (nová revize).
- **Hlavičky z aplikace** (`src/web/hlavicky.ts`): CSP (self, styly inline, img data:/blob:, frame-src youtube-nocookie + player.vimeo), nosniff, Referrer-Policy, X-Frame-Options, HSTS na https, `ROBOTS_NOINDEX=1` → X-Robots-Tag (dev compose). Ověřeno: Quill, náhled vzhledu, přehrání YouTube po kliknutí bez chyb CSP.
- **`/sitemap.xml`** (stránky, aktuality, akce, galerie, aktuální deska, moduly) a **`/robots.txt`** se Sitemap (dev robots dál přebíjí NPM).
- **Úřední deska:** `ud_kategorie.archiv_verejny` — sejmuté dokumenty jiných úřadů nejsou ve veřejném archivu (detail 410, příloha jen pro roli deska); nové kategorie **Pozvánky na zasedání ZO** (min. 7 dní) a **Poskytnuté informace** (6 let, odkaz z bodu 9); RO se sejme spolu s rozpočtem, který mění (§ 16 odst. 5). Pilot: 116 dokumentů přeřazeno do „Oznámení jiných úřadů“ (exekuce, dražby, vláda, finanční úřad, Mikroregion), 77 do pozvánek (audit `deska.prerazeni`).
- **Import:** popis obrázku jen ze zdroje (obecné/název souboru → prázdný = chybí popis), nadpisy bez přeskakování; Správa webu ukazuje „Obrázky bez popisu“. Pilot: vymyšlené popisy vyprázdněny (170 obrázků ve 45 stránkách/článcích, 279 souborů) — redaktor je doplní, jinak stránku znovu nezveřejní.
- Drobnosti: `/akce/null` z titulky, datum aktualizace u stránek, nadpisy v seznamech desky/aktualit, RSS popis.
- Testy `test/audit-souladu.test.ts` (17), celkem 173; axe-core 0 porušení na 16 veřejných a 7 administračních stránkách. Záloha DB `backups/platforma-dev-2026-10-19-pred-opravami-auditu.sql.gz`.
- **Na úřad:** zkontrolovat výchozí texty bodů 2, 9, 10 a 4.6 (nosiče dat), doplnit sazebník (12.1) a výroční zprávy (14), popisy obrázků, zpracovatele (SMS, e-mail) v `obec.yml`; vlastní prohlášení o přístupnosti pilotu zmiňuje popisy „odvozené z názvu souboru“ — teď chybí úplně, upravit větu.

## Videa (19. 10. 2026)

- **Správa → Obecní web → Videa** (role `web`): název, krátký popis, zdroj = odkaz na YouTube/Vimeo **nebo** vlastní soubor MP4/WebM (do 300 MB) s plakátem, volitelně titulky (WebVTT, SRT se převede) a textový popis/přepis; pořadí šipkami, „na titulce“, koncept/zveřejněno, koš s obnovou. Veřejně sekce **Videa** na titulce (pod úřední deskou a akcemi, nad „Podpořili nás“, max. 4) a stránka `/videa`.
- **Soukromí:** u YouTube/Vimea se při uložení stáhne náhled (`i.ytimg.com/…/maxresdefault.jpg`, jinak `hqdefault` oříznutý na 16:9; Vimeo přes oEmbed) a název do vlastního úložiště. Na webu je jen obrázek s tlačítkem „Přehrát video“ a větou, že se video načte z YouTube (Google); `<iframe>` z `youtube-nocookie.com` (Vimeo `dnt=1`) vloží `public/js/web.js` až po kliknutí. Bez JS je náhled odkazem na službu. Platforma ani NPM žádnou CSP nemají (ověřeno hlavičkami) — kdyby se zaváděla, povolit `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`.
- **Vlastní video:** `<video controls preload="none" playsinline poster>` + odkaz ke stažení; `/soubory` nově umí **HTTP Range** (206, 416, `accept-ranges`), video a titulky se posílají inline. Nahrávání: multipart limit 300 MB jen pro přihlášeného na `/sprava/web/videa*`, jinde dál 30 MB (soubor se ořízne → chyba). Video se ukládá streamovaně (do paměti se nenačítá). Platforma video **nepřekódovává** (bez ffmpeg) — nápověda radí 720p, 2–3 Mb/s, faststart.
- **Video v textu stránky:** `<figure class="video" data-video="<id>"><a href>Název</a></figure>` — sanitizace ho pustí, šablona obsahu ho vykreslí stejným přehrávačem (zveřejněné video; koncept/koš zmizí). Editor (Quill) ho zachová jako blok a má tlačítko **▶ Video** (výběr z knihovny).
- **Import:** `najdiVidea()` v `import/html-pomoc.ts` (sdílené pro všechny adaptéry) rozpozná iframe YouTube/Vimeo, Gutenberg „Vložení“, `<video>` / `[video]` z WordPressu a `[embed]`; importér založí video v knihovně (zveřejněné, ne na titulce; YouTube podle id a soubor podle původní URL jen jednou) a do textu dá značku. Video na cizím serveru zůstane odkazem.
- **Pilot (dev):** stránka „Letecké snímkování obce 2022“ má na začátku video YouTube `p2XGixzTB8E` (nová revize přes `ObsahSluzba.uloz`, zbytek obsahu beze změny); na titulce „Letecké snímkování obce 2022“ (YouTube, náhled maxres) a „Vlastibořice 2024“ (MP4 převedené na 720p H.264 ~1,5 Mb/s + faststart: 111 MB → 46,5 MB; plakát z vlastiborice.cz). Záloha DB před zápisem `backups/platforma-dev-2026-10-19-pred-videi.sql.gz`.
- **Ověření:** `test/videa.test.ts` (12 testů: odkazy, VTT, Range, limit, detekce v importu, správa, titulka bez iframe, MP4 s titulky, pořadí/koš, video v textu, import WordPressu); celkem 156 testů, lint, prettier, tsc. axe-core 0 porušení na `/`, `/videa`, stránce s videem a ve správě videí (opraven i starší nález: přístupný název tlačítka Tabulka v editoru).
- Zbývá / k rozhodnutí: délka a rozměr vlastního videa se nezjišťují (bez ffprobe; rámeček je 16:9); u MP4 2024 chybí textový popis/titulky (obsah videa nevím — doplní úřad); YouTube náhled má v obrázku černé pruhy, pokud je má video samo.

## Etapa 1c — vzhled veřejného webu (18. 10. 2026)

- **Barevná schémata (9, OKLCH, kontrast AA ověřený testem i axe-core):** Zelená obecní (Vlastibořice — tmavá zelená + žlutý pruh), Oranžová outdoor (podle pvlh24.cz; původní oranžová `oklch(0.646 0.222 41)` je mimo sRGB a bílý text na ní má jen 3,6 : 1 — tlačítka proto tmavší `oklch(0.55 0.175 38)`, světlá varianta na tmavé), Úřední modrá, Vínová, Lesní, Břidlicová, Terakota, Švestková, Mořská + vlastní barva.
- **Písma (8 dvojic, self-hosted, čeština ověřena):** Ubuntu (výchozí, Voltí písmo i písmo dnešního webu Vlastibořic), Atkinson Hyperlegible (maximální čitelnost), Inter + Rubik, Source Sans 3, Tradiční (Source Sans 3 + Merriweather), Nunito, Genos (pvlh24), Genos + Rubik Dirt (ozdobný titulek). Velikost: normální / velké 20 px / největší 22 px — výchozí ze správy, návštěvník si přepne A / A+ / A++ (cookie, bez JS).
- **Pozadí:** více fotek, pevná / náhodná při načtení / střídání (prolínání po 25 s, přednačtení); fixní vrstvy fungují i na iOS; gradient přes fotku; sklo s `@supports` zálohou.
- **Titulka:** hero přes celou výšku s vodoznakem znaku, odznakem (motto), velkým názvem obce, statistikami (fakta z `obec.yml` + živé agregáty: dokumenty na desce, odběratelé infokanálu, zprávy za měsíc, nejbližší akce; čísla se napočítají), kaskádové animace; rychlé odkazy, karty aktualit (1/2/4 sloupce, zoom obrázku), úřední deska a akce v panelech, pás dárců; patička ve 4 sloupcích. Plovoucí skleněné menu se shimmerem (desktop), mobilní menu s hledáním. Vše bez pohybu při `prefers-reduced-motion`; funguje bez JS.
- **Správa → Obecní web → Vzhled:** miniatury schémat, ukázky písem, výchozí velikost, znak (+ náhled ikony), fotky pozadí (víc najednou, odebrat, pevná), motto; **Náhled celého webu** (jen pro správce, pruh Použít / Ukončit náhled), **Použít na webu**, **Vrátit předchozí vzhled**.
- **Ikony ze znaku:** `/favicon.ico` (ICO 16/32/48), `/ikona-32.png`, `/apple-touch-icon.png` (180), manifest 192/512; bez znaku výchozí ikona platformy.
- **Pilot:** zelené schéma, písmo Ubuntu, znak Vlastibořic (z vlastiborice.cz), 10 leteckých fotek obce na pozadí se střídáním, fakta 357 obyvatel / 4 osady / 377 m n. m.
- **Ověření:** axe-core 0 porušení na 31 stránkách (všech 9 schémat × titulka, úřední deska, aktuality + správa vzhledu); testy `test/schemata.test.ts`, `test/vzhled.test.ts`.
- Opraveno: řádky šablon začínající `[` / `(` způsobovaly chybu 500 (Eta bez středníku) — test.
- Zbývá: náhledy schémat jen pro titulku/desku/aktuality v automatickém auditu (ostatní stránky sdílí styl); hero na úzkých telefonech s 6 statistikami je vysoký (lze omezit počet faktů v `obec.yml`); fotky pozadí se nevydávají jako WebP (JPEG 1920 px, ~300–600 kB).

## Etapa 1 (18. 10. 2026) — hotovo

1. **Citlivé změny účtu jen po čerstvém ověření** (nález bezpečnostního testera, ADR 14): změna e-mailu a hesla vyžaduje staré heslo nebo nový SMS kód na telefon účtu (platí 10 min); nový e-mail čeká na potvrzení kódem a do té doby neplatí pro přihlášení heslem; odebrání e-mailu zruší heslo; po změně SMS „pokud jste to nebyl(a) vy“ a odhlášení ostatních sezení i OIDC grantů; audit, IP limity. Přihlášení telefonem beze změny. Testy `test/zmeny-uctu.test.ts`.
2. **Úřední deska + rozpočet + povinně zveřejňované informace** (modul `deska`, ADR 19): kategorie (editovatelné) se zákonným minimem dní, výchozí lhůta, vyvěšení dopředu, automatické sejmutí podle data, veřejný archiv s filtrem (kategorie, rok, hledání), RSS, detail s přílohami (PDF/Office/obrázky, kontrola obsahu, obrázky bez EXIF), předčasné sejmutí jen s důvodem, koš s obnovou; „vyvěsit + rozeslat“ přes infokanál (e-mail, SMS na vyžádání); rozpočtová dokumentace (návrh/schválený rozpočet, RO, výhled, závěrečný účet) s pravidlem „zveřejněno do schválení nového“ (`/rozpocet`); povinné informace ve struktuře vyhl. 515/2020 Sb. (`/povinne-informace`) plněné z `obec.yml`, výchozích textů a textů úřadu, chybějící body zvýrazněné. Role: redaktor vkládá a upravuje, správce/admin vše.
3. **Obecní web — úzký redakční systém** (modul `web`, ADR 15–18): stránky (menu 2 úrovně, pořadí šipkami), aktuality (datum, perex, obrázek, kategorie, RSS), akce/kalendář, fotogalerie (víc fotek najednou), dokumenty ke stažení, kontakty z profilu obce, hledání (Postgres fulltext bez diakritiky s jednoduchým kmenem), editor Quill 2 (jen struktura, obrázky přes server s povinným popisem, tabulky), náhled před zveřejněním, koncept vs. zveřejnit, automatické ukládání, revize s obnovou, koš, hlášky s odkazem; **dotace** (průvodce ve 3 krocích s náhledem pásu log, zobrazení od–do, pás na titulce a volitelně v patičce, upozornění 30 dní před koncem); **vzhled** (barva s automatickým kontrastem, znak, úvodní foto, motto); titulní stránka (úvodní foto, rychlé odkazy, aktuality, výběr z úřední desky, akce, dárci); článek z hlášení infokanálu → aktualita. **Import**: rozhraní adaptérů, společný importér, adaptér WordPress (REST) a **Galileo** (HTML), CLI, přesměrování 301 starých adres (`docs/IMPORT.md`).
4. **Pilot Vlastibořice na devu**: obsah https://vlastiborice.cz naimportován přes veřejné WP REST API (2 požadavky/s, User-Agent s kontaktem): **66 stránek, 155 aktualit (od 18. 10. 2024), 1 018 dokumentů úřední desky (celá historie, 9 aktuálně vyvěšených), menu (10 odkazů + rozcestníky), 3 dotace, 1 077 souborů (660 MB na disku), 1 369 přesměrování starých adres**. Chyby: 2 soubory (jeden PDF s nerozpoznaným obsahem, jeden přes 30 MB). `obec.yml` s veřejnými údaji obce (IČO 00671878, adresa Vlastibořice 23, 463 44 Sychrov, úřední hodiny, vedení, zastupitelé, pověřenec GDPR). Úvodní fotka = budova obecního úřadu z importovaného obsahu. Automatický audit **axe-core (WCAG 2.1 A/AA): 0 porušení** na 19 veřejných i administračních stránkách; screenshoty desktop/mobil prohlédnuté.
5. **Navíc: adaptér Galileo** — zkušební běh read-only na webu obce Pertoltice pod Ralskem (Galileo, 1 požadavek/s) do dočasné databáze: 25 stránek, 7 aktualit, 66 dokumentů úřední desky s přílohami a daty vyvěšení/sejmutí, 118 souborů (40 MB), 0 chyb. Data se do devu neimportovala; dočasná DB smazána.

Opraveno navíc: šablony skládaly atributy v escapovaném výstupu (`aria-current=&quot;page&quot;` — chyba už z etapy 0, aktivní položka menu se neoznačovala); hlídá to test.

### Jak to vyzkoušet na devu

https://dev.vlastiborice.cz — veřejný náhled pilotní instalace (přístupy do správy předává správce instalace).

- Web obce: titulka `/`, menu z importu, `/aktuality`, `/akce`, `/galerie`, `/dokumenty`, `/dotace`, `/hledat?q=…`, `/kontakt`.
- Úřední deska `/uredni-deska` (+ archiv, RSS), `/rozpocet`, `/povinne-informace`.
- Staré adresy fungují: např. `https://dev.vlastiborice.cz/category/uredni-deska/` nebo adresa libovolného článku z vlastiborice.cz → 301 na nový obsah.
- Správa: `/sprava` → Obecní web (dlaždice: Napsat aktualitu, Stránky a menu, …, Vzhled, Koš, Přesměrování), Úřední deska (Vyvěsit dokument), Povinně zveřejňované informace.
- Účet: `/ucet` → Změnit e-mail / Nastavit heslo (vyžádá si ověření).

### Rozhodnutí, která jsem udělal sám (k potvrzení Dušanem)

- **Účet s heslem se před změnou může ověřit i SMS kódem** („heslo si nepamatuji“) — telefon je kotvou účtu, takže to bezpečnost nesnižuje a zapomenuté heslo se dá změnit.
- **Po změně e-mailu/hesla se ruší i OIDC granty** → externí aplikace (MujÚčet apod.) budou chtít znovu přihlásit; aktuální relace zůstává.
- **Struktura 14 bodů** podle přílohy vyhl. 515/2020 Sb., jak ji znám (1 název … 14 výroční zpráva, s podbody 4.1–4.8, 8.1–8.2, 11.1–11.2, 12.1–12.2, 13.1–13.2). Výchozí texty (bod 2, 9, 10, 11.1, 12.2, 13.x) jsou návrhy — **ověřit s úřadem/právníkem**.
- **Rozpočtová opatření se automaticky nesnímají** (lhůta podle § 16 zák. 250/2000 Sb. — ověřit); ostatní rozpočtové dokumenty nahrazuje novější téhož druhu.
- **Import úřední desky z WordPressu:** WordPress datum sejmutí nemá → doba vyvěšení = výchozí lhůta kategorie (min. 15 dní), rozpočet do zveřejnění novějšího, RO letošního roku do odvolání. Importovaná je **celá historie desky** (archiv), aktuality jen za poslední 2 roky. Kategorie dokumentů se odhadují z názvu — úřad je může přeřadit.
- **Menu z importu:** položka s podnabídkou je rozcestník (nová stránka s dlaždicemi), stránky mimo menu zůstávají dostupné, ale skryté; „více →“ a „ÚVOD“ se přeskakují.
- **Dotace z patičky** vlastiborice.cz jsou plakáty publicity (ne čistá loga) — založil jsem 3 projekty (hřiště a veřejné osvětlení — Liberecký kraj; Vybavení do obce — EU/SZP přes MAS Achát) se zobrazením **bez konce** (doba udržitelnosti neznámá — doplnit ze smluv). Logo Sdružení Český ráj jsem vynechal (členství, ne dotace).
- **Hledání:** u slov ≥ 5 znaků se hledá kmen bez 1–2 posledních písmen (čeština skloňuje) — jednoduché, bez slovníku.
- **Cizí obrázky (widgety) se při importu zahazují**; odkazy na cizí weby zůstávají.
- Kontejner `platforma` na devu: `mem_limit` 640 MB (zpracování fotek a import), volume `platforma_data` pro soubory.

### Co zbývá / nefunguje

- **Galerie se z WordPressu neimportují jako modul Fotogalerie** — galerie v textu stránek se převádějí na mřížku náhledů v obsahu; „fotogalerie“ jako příspěvky přišly jako aktuality s obrázky.
- Soubory nad 30 MB se nenahrají (limit nahrávání); při opakovaném importu se takový soubor stahuje znovu (neúspěch se nepamatuje).
- Znak obce na starém webu není → v hlavičce je výchozí ikona; úřad ho nahraje v Obecní web → Vzhled.
- Galileo: stránky, kde je obsah jen v modulu (kontakty, seznamy), se importují z hlavního bloku stránky — může obsahovat technické zbytky; akce/kalendář a fotogalerie z Galilea se neimportují (v menu vedou na /akce a /galerie).
- Import akcí (kalendáře) z WordPressu/Galilea není; aktuality z Galilea ano.
- Ve správě webu chybí **přesun obsahu mezi typy** (aktualita ↔ stránka) a mazání kategorií aktualit (jen přejmenování a přidání).
- **Neúplné obnovení koše:** obnova galerie/dotace funguje, trvalé smazání záměrně není (pravidlo „nic nemazat“).
- WordPress obsahuje i technické stránky pluginů (např. „My Bookings“) — naimportovaly se mimo menu; úřad je smaže do koše.
- Automatický audit přístupnosti (axe-core v Chromiu) je skript pro vývojáře, ne součást CI.
- Adaptéry vismo, Antee, e-obec jen popsané (`docs/IMPORT.md`).

---

## Etapa 0 (13. 10. 2026)

### Hotovo v etapě 0

- **Kostra:** Fastify + TypeScript (ESM, strict), PostgreSQL 16 přes Kysely s explicitními SQL migracemi (spouští se při startu), šablony Eta s layoutem, `/healthz` (503 při výpadku DB), `obec.yml` validovaný zodem, `.env` validovaný zodem, i18n slovník (`src/i18n/cs.ts`), pino, CSS mobil-first bez JavaScriptu, povinné odkazy v patičce (přístupnost, GDPR, kontakt), stránky prohlášení o přístupnosti / zásad GDPR / kontaktu generované z profilu obce.
- **Účty:** přihlášení telefonem + SMS kód (OTP: HMAC v DB, 10 min, 3/hod, 5 pokusů), účet vzniká sám, GDPR souhlas při prvním přihlášení, volitelný e-mail + heslo (scrypt), profil, role `redaktor/ucetni/spravce/admin` (více najednou) a blokace v `/sprava`, audit log, správa uživatelů s hledáním a historií, přehled OIDC klientů.
- **OIDC provider** (`oidc-provider` 9): issuer `<BASE_URL>/oidc`, discovery, JWKS (ES256 + RS256 v DB), Authorization Code + PKCE povinně, refresh, userinfo, introspekce, revokace, RP-initiated logout (česky), obrazovka souhlasu pro cizí klienty, scope `obec` (`cast_obce`, `rezident`, `role`). Platforma je sama svým klientem (`openid-client`) — ověřeno testem i naživo přes NPM.
- **Infokanál:** odběratelé (telefon/e-mail, část obce, preference `sms/smisene/email`, kategorie s opt-outem, souhlas, zdroj, vazba na účet), veřejné přihlášení k odběru s OTP (z účtu bez kódu), správa odběru, odhlášení odkazem, hlášení (SMS/e-mail/článek, krizové, cílení na části, plánování, „SMS jen bez e-mailu“), fronta se dvěma proudy, tempem, 3 pokusy a zastavením, doručenky (polling + webhook), správa pro redaktory (seznam, nové, detail se stavy příjemců, odběratelé + přidání úřadem).
- **Ochrana přihlašování (15. 10. 2026, podle nálezu M. Ketnera ve VlastiKanálu):** limity podle IP v paměti (`src/lib/limit.ts`: odeslání kódu 10/15 min, ověření kódu 20/15 min, heslo 20/15 min → 429), IP z `X-Forwarded-For` jen přes `TRUST_PROXY_HOPS` proxy (výchozí 1 — s `trustProxy: true` byla IP podvrhnutelná), správa odběru posílá kód jen existujícímu odběrateli a odpovídá neutrálně („Pokud číslo … máme“), blokace účtu se prozradí až po správném kódu. Test `test/limity.test.ts`.
- **SMS abstrakce:** `konzole`, `smsgate`, `smsbrana`, `gosms`, `smsmanager` (komerční podle dokumentace, testy s falešným fetch). **E-mail:** `konzole`, `smtp`.
- **Výstrahy:** návrh rozhraní (`src/moduly/infokanal/vystrahy/typy.ts`) + průzkum zdrojů ČHMÚ / ČEZ / SčVK (voda) v `docs/MODULY.md`.
- **Testy:** Vitest, 8 souborů, **56 testů** (jednotkové: kontakty, výběr příjemců, SMS adaptéry, OTP+hesla; HTTP: účty, OIDC externí klient, infokanál). `npm run lint` (ESLint + Prettier) i `npm run build` procházejí v kontejneru Node 22.
- **Infrastruktura:** Dockerfile (multi-stage, uživatel `node`, healthcheck), `docker-compose.yml` (app + Postgres + Caddy), `docker-compose.dev.yml`, `docker-compose.dev-server.yml`, CI workflow (lint, typy, testy s Postgres service, build obrazu), `dev.sh` pro práci bez lokálního Node.
- **Dev nasazení:** pilotní instalace na https://dev.vlastiborice.cz (kontejnery `platforma` + `platforma_db`, `SMS_PROVIDER=konzole` + `OTP_DEV_ZOBRAZIT=1` → SMS kód se ukazuje přímo na stránce; dovoleno jen s konzolovým poskytovatelem).

### Jak to vyzkoušet (etapa 0)

1. Spustit lokálně podle `docs/VYVOJ.md` (nebo pilotní instalaci https://dev.vlastiborice.cz).
2. „Přihlásit se“ → zadat telefon (první účet dostane roli admin podle `docs/VYVOJ.md`) nebo jakékoliv jiné číslo (vznikne občan) → kód je vypsaný v modrém rámečku na stránce (žádná SMS neodchází) → GDPR souhlas → `/ucet`.
3. Admin: `/sprava` → Uživatelé (role, blokace), Audit log, OIDC klienti; `/infokanal/sprava` → Nové hlášení → po odeslání detail ukazuje stavy příjemců (konzolový poskytovatel „doručí“ hned; skutečné SMS/e-maily nikam nejdou, jsou v `docker logs platforma`).
4. Občan: `/infokanal` → přihlášení k odběru (kód opět na stránce) → `/infokanal/odber`.
5. OIDC pro externí aplikaci: `https://dev.vlastiborice.cz/oidc/.well-known/openid-configuration`; klient se zakládá SQL do `oidc_klienti` (viz `docs/VYVOJ.md`).

Provoz pilotní instalace: `docker compose -f docker-compose.dev-server.yml logs -f platforma`; nové nasazení `docker compose -f docker-compose.dev-server.yml up -d --build`.

### Vědomé zkratky etapy 0 (část už vyřešena v etapě 1)

- **Komerční SMS brány nejsou ověřené naživo** (žádný účet) — adaptéry odpovídají dokumentaci a mají testy, první skutečné odeslání může odhalit detail (SMSbrána: tolerance času, názvy `salt/sul`; SMS Manager: registrace odesílatele). Cron pro `stahniDorucenky()` u SMSbrány a příjem SMS `START/STOP` chybí.
- **Výstrahy (ČHMÚ/ČEZ/voda)** jen návrh rozhraní, bez implementace (zadání etapy 0).
- **Správa OIDC klientů** jen SQL; formulář v administraci chybí. Federace na NIA / Bank iD není.
- **Chybějící jméno, změna telefonu se schválením, GDPR výmaz, Rezident přepínaný úřadem** — v datovém modelu je místo (`rezident`, audit), ale UI a procesy přijdou v etapě 1.
- **Článek na web** se jen ukládá (`clanek_html`), nikam se nepublikuje (úřední deska je modul etapy 1; napojení na WordPress REST zatím není).
- **E-mail HTML** je jednoduchý (odstavce z textu); editor s obrázky a přílohy nejsou.
- **Hromadný import odběratelů** (CSV) není — jen ruční přidání úřadem a seed.
- **Vzhled** je funkční a přístupný, ale obecný (zelená obce); barvy obce z `obec.yml` zatím nejde měnit.
- Lišta „Moje obec“ napříč aplikacemi z Vlastibořic tu není — v monolitu není potřeba (jedna hlavička).
- Zálohy jsou popsané v `docs/INSTALACE.md`, ale cron se nezakládá automaticky.
- Prohlášení o přístupnosti je šablona s datem vypracování = dnes; obec si ho má projít a potvrdit vlastním posouzením.

## Doporučení pro další práci (po etapě 1)

1. Projít s úřadem Vlastibořic importovaný web: kategorie dokumentů desky, stránky mimo menu (technické stránky pluginů do koše), doby udržitelnosti dotací, výchozí texty povinných informací.
2. Adaptér **vismo** (druhý nejčastější CMS), pak Antee a e-obec — stejný princip jako Galileo.
3. Dokončit infokanál (výstrahy ČHMÚ/ČEZ/voda, příchozí SMS START/STOP, import CSV, HTML editor hlášení — editor už existuje).
4. Procesy úřadu v účtech (změna telefonu se schválením, GDPR výmaz, Rezident, dashboard).
5. Rezervace + vyúčtování.
6. Audit přístupnosti (axe-core skript) a e2e do CI; publikace obrazu do registru.

### Původní doporučení pro etapu 1 (13. 10. 2026)

1. **Úřední deska + povinně zveřejňované informace** (zákonné minimum obecního webu, dnes řeší WordPress): dokumenty s dobou vyvěšení a archivem, 14bodová struktura, rozpočtová dokumentace, RSS; „vyvěsit + rozeslat“ přes infokanál (dořeší i `clanek_html`).
2. **Dokončit infokanál:** výstrahy ČHMÚ/ČEZ/voda podle návrhu rozhraní, příchozí SMS `START/STOP` (webhook brány), import CSV, HTML editor s obrázky/přílohami, statistiky (agregáty).
3. **Účty — procesy úřadu:** změna telefonu se schválením, chybějící jméno, GDPR výmaz (anonymizace), Rezident, avíza správcům, formulář OIDC klientů, dashboard úřadu.
4. **Ověřit jednu komerční SMS bránu naživo** s první obcí (SMS Manager nebo SMSbrána) a nastavit webhook doručenek.
5. **Rezervace + vyúčtování** (největší modul; začít kalendářem, schvalováním a ceníkem).
6. Vydat obraz do registru (GHCR), verzovat (`0.1.0`), přidat `npm audit`/Dependabot do CI, e2e test v prohlížeči (Playwright) pro klávesnici a přístupnost.
