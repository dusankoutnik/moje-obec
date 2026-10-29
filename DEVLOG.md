# Co je nového (devlog)

Přehled změn platformy Obecní web od Voltu 2.0 pro pilotní obec, nejnovější nahoře. Technické podrobnosti jsou v CHANGELOG.md.

## 29. 10. 2026

- **Fotky v textu jdou zmenšit a obtékat textem:** po kliknutí na fotku se u ní objeví lištička — velikost (malá, střední, velká, celá šířka), umístění vlevo nebo vpravo s textem vedle, nebo na střed, popis, titulek, odkaz a výměna za jinou fotku. Velikost jde měnit i tažením za roh fotky; přichytává se k hezkým poměrům (třetina, polovina…), takže to vypadá dobře i „od oka“. Na mobilu je každá fotka přes celou šířku.
- **Fotogalerie v příspěvku:** tlačítkem **Galerie** vložíte do textu existující fotogalerii, nebo rovnou založíte novou z fotek. Když do textu přetáhnete víc fotek najednou, editor nabídne udělat z nich galerii. V textu se ukáže pár náhledů (mřížka, pás, nebo velká fotka s náhledy) a návštěvník si fotky prohlédne v prohlížeči přes celou obrazovku. Galerie je v textu „živá“ — přidané fotky nebo opravené popisky se projeví i v příspěvku.
- U galerie je nově zatržítko **Zobrazit na stránce Fotogalerie**. Bez něj je galerie „jen pro příspěvky“: na stránce Fotogalerie ji návštěvníci nevidí, ale v příspěvku ano. Galerie ve správě ukazuje, ve kterých příspěvcích je vložená, a před skrytím nebo smazáním na to upozorní.
- **Rychlé vkládání přes lomítko:** napíšete „/“ na začátek řádku a vyberete nadpis, seznam, fotku, galerii, video, tabulku… Bloky textu jde přesouvat myší za úchyt ⠿ vlevo.
- **Kontrola před zveřejněním** upozorní na fotku bez popisu pro nevidomé, odkaz „zde“, prázdný nadpis, text psaný velkými písmeny nebo moc fotek pod sebou (nic nezakazuje, jde „Přesto zveřejnit“). Přibyl **náhled na mobilu** a pro redaktory webu ruční úprava **HTML** (nepovolené věci jako styly a skripty se vynechají a editor řekne které).
- **Akce z rezervací:** když se termín v rezervacích přejmenuje, nový název se propíše i do zveřejněné akce — pokud redaktor název sám neměnil. Vlastní název redaktora zůstává.

## 28. 10. 2026

- **Nový editor textu** v administraci (příspěvky, stránky, povinné informace, hlášení): obrázek se vloží tam, kde je kurzor (tlačítkem, přetažením i ze schránky), dá se myší přesunout jinam a po kliknutí na něj se objeví lišta s popisem, **titulkem pod obrázkem** a velikostí (malý / střední / celá šířka). Tabulky mají záhlaví, přidávání a mazání řádků a sloupců a slučování buněk. Přibyla vodorovná čára, nadpis třetí úrovně, tlačítka Zpět a Znovu a odkaz přes Ctrl+K. Stávající články včetně galerií a videí zůstávají beze změny.

## 23. 10. 2026

- **Počasí na webu:** na titulce je dlaždice s předpovědí na dnes, zítra a pozítří (na telefonu dnes a zítra) — teplota, srážky, vítr a obrázek počasí. Když ČHMÚ vydá pro naše území výstrahu, ukáže se nahoře v dlaždici jako barevný pruh. Na stránce **Počasí** je předpověď po hodinách na dva dny (graf i tabulka) a na celý týden. Předpověď je od norského meteorologického ústavu (yr.no) a obnovuje se každou půlhodinu; váš prohlížeč se přitom nikam cizím nepřipojuje.
- Kde má dlaždice na titulce být (v úvodu s fotkou, pod rychlými odkazy, nebo vůbec), si správce vybere ve Správě → Vzhled a může si to předem prohlédnout v náhledu.

## 22. 10. 2026

- **Rezervace a eKnihy vypadají jako web obce:** aplikace dostávají od webu hotovou hlavičku se znakem, hledáním, velikostí písma a účtem, stejné plovoucí menu, patičku, fotky obce v pozadí i bílou kartu obsahu. Pod hlavním menu mají své podmenu (na telefonu se posouvá do strany). Odhlášení v hlavičce odhlásí ze všeho najednou. Tmavá lišta „Moje obec“ nad aplikacemi tím končí — odkazy na služby jsou v hlavním menu pod položkou Moje obec.
- **Tlačítko A pro úřad:** kdo má v obci nějakou správcovskou roli, vidí v hlavním menu vpravo oranžové **A** — vede rovnou do Administrace (na webu i v aplikacích).
- **„Správa“ se přejmenovala na „Administrace“** (nadpis, patička, odkazy zpět). Adresa zůstává stejná; stará `/administrace` přesměruje.
- Rámec webu (hlavička, menu, patička, pozadí) je nově v samostatném souboru stylů, který sdílí web i aplikace — po změně vzhledu ve Správě → Vzhled se tedy přebarví i rezervace a eKnihy.
- **Úřad má všechno ve Správě:** na úvodu Správy jsou nově i dlaždice rezervací (čekající žádosti, nezaplacená vyúčtování, předprodej, spolujízda) s aktuálními počty, stránka **Schvalování** (potvrzení rezervací a posilovny, posouzení, kdo je rezident, doplnění jména u účtů bez jména) a **Statistiky** se souhrnnými čísly pro zastupitelstvo. Správci dostanou e-mail, když vznikne nový účet, u kterého je potřeba posoudit rezidenta.
- **Můj účet na jednom místě:** stránka Můj účet sdružuje všechna nastavení — osobní údaje, odběr hlášení obce (SMS nebo i e-mail a co chcete dostávat), rezervace a platby s výzvami k úhradě a QR platbou, přístupy do posilovny a eKlíč, spolujízdu i SMS o nových e-knihách. Změnu telefonu schvaluje úřad. Své údaje si můžete stáhnout a požádat o výmaz účtu.
- **Služby obce jdou zapnout a vypnout:** ve Správě → Moduly obce správce jedním zatržítkem zapne nebo vypne Rezervace, Předprodej vstupenek, Spolujízdu, eKnihy, Infokanál a Kvíz. Vypnutá služba zmizí z menu i z úvodu a místo ní se ukáže „Tato služba není v obci zapnutá“; data zůstávají a po zapnutí je vše jako dřív.
- **Vše pod jednou adresou:** rezervace a eKnihy poběží přímo na webu obce na adresách `/rezervace/` a `/eknihy/` (místo samostatných subdomén).
- **Web má API:** programy úřadu mohou na web samy přidávat zprávy, akce a dokumenty na úřední desku — třeba
  sazba obecního zpravodaje po vysázení rovnou zveřejní nové číslo i s obsahem, tabulkami a obálkou. Přístup
  povoluje administrátor tokenem ve Správa → API a integrace (každý token smí jen to, co mu dovolíte, a jde
  kdykoli zrušit). Počet obyvatel v úvodu se teď bere z posledního zpravodaje. Popis pro vývojáře je v patičce
  pod odkazem **API**.
- **Hledání najde i to, co je uvnitř dokumentů:** vyhledávání na webu nově prohledává obsah nahraných PDF,
  Wordů a tabulek — ne jen jejich názvy. U naskenovaných PDF se text přečte rozpoznáváním písma (trvá to pár
  minut na dokument, běží na pozadí na serveru obce). Výsledek ukáže úryvek se zvýrazněnými slovy a odkaz na
  úřední desku nebo stránku, kde dokument je. Hned po nahrání PDF se správce dozví, jestli má dokument textovou
  vrstvu, a ve Správa → Obecní web → Text dokumentů vidí, co čeká, co se právě zpracovává a co se nepovedlo
  (s tlačítky „Zpracovat znovu“, „Zpracovat teď“ a hromadnou kontrolou všech dokumentů).
- **Prázdné rubriky se skrývají:** rubrika bez jediného příspěvku (např. Sport) se nenabízí ve filtru Aktualit ani v menu; na úřední desce totéž u kategorií bez dokumentů. Redaktor je v editoru vidí dál — jakmile něco zveřejní, rubrika se objeví.
- **Akce z rezervací se samy připraví na web:** když si někdo zarezervuje sál nebo hřiště pro veřejnou akci,
  ve správě webu se objeví připravená akce k doplnění textu a fotky. Akce, kterou už na webu máte, se s rezervací
  spáruje — v kalendáři se pak neukáže dvakrát. Když se v rezervacích změní termín nebo se akce zruší, správa
  na to upozorní.
- **Pozvánka i mezi zprávami:** akci jde jedním zatržítkem ukázat i v Aktualitách.
- **Rozeslat jedním tlačítkem:** zveřejněnou zprávu nebo pozvánku jde poslat občanům SMS a e-mailem — text se
  předvyplní sám a u příspěvku je vidět, kdy a kolika lidem odešel.
- **Čísla na úvodu jsou klikací** a vedou tam, kde se o nich dozvíte víc; nově je tam pět nejbližších akcí.
- **Nový název:** platforma se jmenuje **Obecní web od Voltu 2.0**, v patičce je logo Voltu s odkazem na Volt Česko.
- **Vzhled:** fotka obce v pozadí je víc vidět; texty přímo na fotce mají vlastní tmavý podklad, aby zůstaly čitelné.
- **Efekty tlačítek menu** ve Správě → Vzhled: decentní odlesk, vodní hladina, dýchání nebo bez efektu, a k tomu síla efektu. Kdo má v zařízení zapnuté „omezit pohyb“, vidí tlačítka vždy v klidu.
- **Odstávky elektřiny:** v kartě na titulce je i obrázkový banner ČEZ (stahuje ho náš server, návštěvník nic z cizího serveru nenačítá).
- **Staré odkazy fungují:** soubory starého webu (`/wp-content/uploads/…`) jsou dostupné na původních adresách; prohlížečům stálých návštěvníků se starý „offline“ režim sám odinstaluje.
- Odkaz **Správa** se přesunul z hlavičky do patičky.
- Tato stránka (devlog) v patičce testovacího webu.
- **Telefon:** úvod zabírá jen horní část obrazovky (jen název obce, bez statistik a šipky), obsah je hned pod ním; opravené odstupy na stránce Kontakt.

## 21. 10. 2026

- **Kvíz pro občany:** 350 otázek v 9 oblastech se zdroji, místní otázky o Vlastibořicích, skóre u účtu nebo anonymně; správci vidí statistiky hráčů a mohou přidávat vlastní otázky.
- **Elektronická podatelna:** formulář pro podání bez elektronického podpisu, číslo podání, potvrzení podateli, evidence a vyřizování ve správě.
- **Odstávky elektřiny ČEZ** na titulce a na stránce `/odstavky` s historií za 30 dní.
- Obecně závazné vyhlášky (platné i historie) a formuláře ke stažení; na titulce nejbližší akce.

## 19. 10. 2026

- **Videa:** YouTube a Vimeo „na dva kliky“ (nic se nenačítá bez souhlasu), vlastní videa s titulky.
- **Aktuality ze starých webů obce** z let 2002–2009 (z internetového archivu) v kategorii „Archiv starého webu“.
- **Úklid importovaného webu:** jeden strom menu, přesměrování starých adres, mapa stránek, nativní kontakt, ochrana osobních údajů a prohlášení o přístupnosti.
- Opravy podle auditu souladu se zákony (povinné informace podle vyhlášky 515/2020 Sb., přístupnost, cookies) a podle bezpečnostní kontroly kódu (zámek přihlášení heslem, náhled „co se sejme“ na desce, přehled SMS ve správě).

## 18. 10. 2026

- **Úřední deska, rozpočet a povinně zveřejňované informace** jako součást platformy.
- **Obecní web:** stránky, aktuality, akce, galerie, dokumenty, dotace s logy, hledání, koncepty, náhled a historie změn.
- **Import ze starého webu:** obsah vlastiborice.cz převzat (stránky, aktuality, úřední deska, soubory).
- **Vzhled:** 9 barevných schémat s hlídáním kontrastu, výběr písem, velikost písma pro návštěvníky, střídání leteckých fotek obce v pozadí, favicon ze znaku.
- Akce sálu a hřišť z rezervačního systému v kalendáři akcí; citlivé změny účtu jen po novém ověření.
- Testovací web zpřístupněn veřejně k ukázce.

## 15. 10. 2026

- Ochrana přihlašování kódem: limity pokusů, neutrální odpovědi (nejde zjistit, kdo je v evidenci).

## 13. 10. 2026 — začátek

- Kostra otevřené platformy pro obce (licence EUPL-1.2): účty s přihlášením telefonem a SMS kódem, standardní jednotné přihlášení (OpenID Connect), infokanál pro SMS a e-mailová hlášení s adaptéry SMS bran, testy a dokumentace. Testovací web dev.vlastiborice.cz.
