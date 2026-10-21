# Moduly — zadání modul po modulu

Zdrojem je tříměsíční provoz aplikací ve Vlastibořicích (MujÚčet, Rezervace, VlastiKanál, eKnihy, WordPress) popsaný v provozní dokumentaci obce. Zde je sepsáno, **co se z něj bere jako požadavek** (ne kód), včetně zákonných povinností. Priorita: **P0** = etapa 0 (hotovo), **P1** = etapa 1, **P2** = později.

## Zákonné požadavky na obecní web (ČR) — souhrn

Orientační přehled (není právní poradenství; ověřit aktuální znění):

1. **Povinně zveřejňované informace** — zákon č. 106/1999 Sb.; struktura dle vyhlášky č. 515/2020 Sb. (14 bodů: název; důvod a způsob založení; organizační struktura; kontaktní spojení; IČO/DIČ/bankovní spojení; dokumenty a rozpočet; žádosti o informace; opravné prostředky; formuláře; popisy postupů; předpisy; sazebník úhrad; licenční smlouvy; výroční zpráva).
2. **Přístupnost** — zákon č. 99/2019 Sb. (WCAG 2.1 A + AA, EN 301 549), **Prohlášení o přístupnosti** (§ 8) — i pro dokumenty a audio/video.
3. **Elektronická úřední deska** — § 26 správního řádu (500/2004 Sb.): dálkový přístup; vyhlášky a nařízení min. 15 dní; GDPR minimalizace.
4. **Registr smluv** — 340/2015 Sb.: smlouvy nad 50 000 Kč bez DPH.
5. **Rozpočtová dokumentace** — 250/2000 Sb.: návrh i schválený rozpočet, střednědobý výhled, závěrečný účet, lhůty.
6. **GDPR** — nařízení 2016/679 + 110/2019 Sb.: zásady ochrany osobních údajů, pověřenec, úřední deska.
7. **Cookies** — § 89 zák. 127/2005 Sb.: opt-in pro nezbytné; platforma používá **jen technické cookies** (sezení, CSRF), lišta není potřeba.
8. **Zákon o obcích** — 128/2000 Sb.: vyhlášky, usnesení a zápisy zastupitelstva, záměry nakládat s majetkem (15 dní).
9. **Provoz** — vlastní doména přes HTTPS, aktualizace, zálohy.

Platforma plní bod 2 (prohlášení, přístupný design), 6 (stránka zásad, souhlasy, audit, výmaz), 7 a 9 v jádru; 1, 3, 4, 5, 8 patří modulu úřední deska (P1).

---

## Jádro: účty a identita (P0 — hotovo)

**Převzato z MujÚčtu:**

- Telefon je kotva účtu a stačí k plnohodnotnému účtu; e-mail a heslo volitelné. Přihlášení kódem z SMS; neznámý telefon po ověření **založí minimální účet** (jméno se doplní později — ve Vlastibořicích to řeší karta „Chybějící jméno“ ve schvalování, P1).
- Jméno a příjmení zvlášť, přezdívka (zobrazuje se ostatním), část obce (z profilu obce), **Rezident** (zdroj pravdy v účtu, aplikace ho jen čtou — rozhoduje ceník, přístup k posilovně).
- **GDPR souhlas** při prvním přihlášení (účty založené úřadem/importem ho potvrdí při nejbližším přihlášení); zobrazeno správci.
- **Role:** občan (bez role), redaktor, účetní, správce, admin; **více rolí najednou** (účetní + redaktor); přiděluje jen admin, sám sobě neměnit. Platforma: `role text[]`, do OIDC claims ve scope `obec`.
- Blokace účtu = okamžité odhlášení ze všech aplikací (platforma maže sezení i OIDC granty).
- Audit log všech změn (kdo, co, kdy, IP); nikdy se nemaže.
- Změna telefonu = žádost schvalovaná úřadem (telefon je přihlašovací klíč), SMS na staré i nové číslo (P1).
- GDPR výmaz napříč aplikacemi: anonymizace + blokace; rezervace a vyúčtování zůstávají kvůli účetnictví (P1).
- Odhlášení z jedné aplikace = odhlášení ze všech (OIDC RP-initiated logout — hotovo).
- Avízo správcům o nové registraci, aby nastavili Rezidenta (P1).
- Poučení z provozu: `verified_at` nastavený i po přihlášení e-mailem mátl párování podle telefonu → platforma má zvlášť `telefon_overen_at` a `email_overen_at`.

**OIDC provider (P0 — hotovo):** discovery, JWKS (ES256 + RS256, generované při prvním startu, v DB), Authorization Code + PKCE povinně, refresh tokeny, userinfo, introspekce/revokace, RP-initiated logout, obrazovka souhlasu pro cizí klienty, důvěryhodné first-party klienty bez souhlasu. Správa klientů zatím SQL (`oidc_klienti`); formulář v administraci P1. **P2:** federace na Identitu občana (NIA) a Bank iD jako upstream IdP (uživatel si k účtu připojí „ověřenou identitu“ — vyšší úroveň důvěry pro úřední agendy).

## Infokanál (P0 — datový model a UI hotové; výstrahy P1)

**Převzato z VlastiKanálu:**

- Odběratel: jméno, telefon a/nebo e-mail, část obce, **preference kanálu** (vše SMS / smíšené = důležité SMS a ostatní e-mail / vše e-mail s krizovými SMS), **kategorie s opt-outem** (povinné: krizové, obecná hlášení; odhlásitelné: kultura, sport, služby, počasí, elektřina, voda), evidence souhlasu, zdroj (web, SMS, úřad, import, účet).
- Přihlášení k odběru veřejně s OTP; přihlášený občan se stejným telefonem bez dalšího kódu; odhlášení odkazem v patičce e-mailu; správa odběru kódem bez účtu. Přidání odběratele úřadem (senior osobně na úřadě). **P1:** SMS `START Jméno` / `STOP` na číslo obce (příchozí SMS přes webhook brány), hromadný import z CSV.
- Hlášení: SMS text (bez diakritiky, prefix obce, počítadlo segmentů), e-mail (předmět, text, HTML s vloženými obrázky — P1 editor), volitelně článek na web (P1: publikace na WordPress REST API nebo vlastní úřední deska). Cílení: všem / části obce / vlastní seznam (P1) + ad-hoc kontakty. Krizové hlášení = oba kanály všem bez ohledu na preference. „SMS jen kontaktům bez e-mailu“ šetří SMS. Plánované odeslání. Přílohy (P1).
- **Fronta:** worker posílá po jedné zprávě s prodlevou (konfigurovatelné tempo — u telefonu jako brány 8–20 s kvůli FUP operátora, u komerční brány krátce; krizové nejrychleji), e-maily a SMS ve dvou nezávislých proudech, 3 pokusy, stav v DB (restart nic neztratí), zastavení rozesílky úřadem. Doručenky: polling à 5 min + webhook. Poučení: SMS čítač se dlouho drží na 0, protože nejdřív jdou e-maily — v UI to říct.
- **SMS brána:** řešení s telefonem na úřadě (SMSGate) se nedá obcím oficiálně nabízet → abstrakce poskytovatele (viz níže). Pozor na UCS-2: typografické pomlčky a uvozovky převádět na ASCII, jinak 70 znaků/SMS.
- Statistiky jen jako agregáty (žádná jména) — P1 dashboard.

### SMS brány — abstrakce a adaptéry (P0)

| Poskytovatel | Stav                                 | Auth                                  | Doručenky                                                      |
| ------------ | ------------------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| `konzole`    | hotovo (vývoj, testy)                | —                                     | vždy „doručeno“                                                |
| `smsgate`    | hotovo (vývoj; ověřeno v provozu VK) | Basic                                 | polling `GET …/message/<id>`                                   |
| `smsbrana`   | podle dokumentace, naživo neověřeno  | login + time + salt + md5(auth)       | polling `action=inbox` (`stahniDorucenky()`), PUSH webhook     |
| `gosms`      | podle OpenAPI, naživo neověřeno      | OAuth2 client_credentials (token 1 h) | `GET /api/v1/messages/{id}`, webhook (pole událostí)           |
| `smsmanager` | podle dokumentace, naživo neověřeno  | hlavička `x-api-key` (JSON API v2)    | `GET rest-api…/v1/message?id=`, webhook s HMAC-SHA256 podpisem |

Ceny (10/2026, bez DPH, orientačně): SMSbrána ~1,08 Kč (s bonusem ~0,89), GoSMS „od 0,41 Kč“ u velkých objemů, SMS Manager 0,89 Kč v pásmu 5–10 tis./měs. (vlastní textový odesílatel +500 Kč/měs.). Doporučení pro obce: začít SMS Managerem nebo SMSbránou (prepaid, bez paušálu). **Úkol P1:** s první obcí ověřit vybraný adaptér naživo, doplnit cron pro `stahniDorucenky()` u SMSbrány, SMS `START/STOP` přes příchozí zprávy.

### Automatické výstrahy (P1 — jen návrh rozhraní, `src/moduly/infokanal/vystrahy/typy.ts`)

Převzaté chování z VlastiKanálu (v provozu od 10/2026): zdroj se polluje cronem, události se dedupují podle klíče, žlutá/informační → jen e-mail správcům s tlačítkem „Rozeslat“, oranžová/odstávka → rozešle se samo (v noci 22–6 h naplánovaně na 6:30), červená → krizová zpráva všem; den předem připomínka; zrušení/změna termínu → další zpráva; cílení na dotčené části obce; při výpadku zdroje > 24 h jedno upozornění; veřejný přehled `/vystrahy`; vypínač v konfiguraci.

**Zdroje:**

1. **ČHMÚ** — open data CAP 1.2 XML `https://opendata.chmi.cz/meteorology/weather/alerts/cap/` (výpis adresáře; `alert_cap_50_DDHHMM.xml` = SIVS výstrahy, nejnovější podle data), dokumentace `.../alerts/metadata/Dokumentace_CAP.pdf`. Filtr na území: geocode **CISORP** (ORP; Vlastibořice = 5109 Turnov, v `obec.yml` jako `orp_cisorp`). Bloky `info` cs + en-GB; „Žádná výstraha…“ přeskočit; stupeň v `awareness_level` („2; yellow; Moderate“); `msgType` Alert/Update/Cancel; `references` na předchozí zprávu. Duplicity: klíč „jev|stupeň“, pokračování = stejný klíč s koncem ne starším než 1 h; nižší stupeň během vyššího se neposílá.
2. **ČEZ Distribuce — plánované odstávky** — web ČEZ i widget berou data z bezstavy.cz; **neoficiální** `GET https://api.bezstavy.cz/cezd/api/inspecttown/<kod_obce>` (Vlastibořice 564516, bez captcha) → `{outages_in_town:[{id, opened_at, fix_expected_at, cancelled_at, announcement_key, addresses…}]}`, PDF oznámení `https://cdn.bezstavy.cz/<announcement_key>`. Rychlé dotazy vracejí 429 → cron 2× denně (7:05, 15:05). Poruchy (neplánované) jen po adresách přes reCAPTCHA → automaticky nepoužitelné.
3. **Voda — SčVK (Severočeské vodovody a kanalizace)** — průzkum 13. 10. 2026. SčVK od 2019 **není ve skupině Veolia** (vlastní SVS); Veolia ČR centrální zdroj odstávek nemá (operátoři PVK, 1.SčV… mají jen HTML seznamy, PVK RSS jen aktuality). Oficiální API/RSS pro odstávky SčVK neexistuje, ale:
   - **HTML seznam** `https://www.scvk.cz/vodovody-a-kanalizace/odstavky-a-havarie/` (+ `/havarie/`, `/planovane-odstavky/`), server-renderovaný, bez stránkování; položka `<a class="component__item is-shutdown|is-accident" href="/udalosti/…-<id>" title="Okres Liberec, obec Vlastibořice, část obce Jivina">` + „Zveřejněno“ + interval + text. Detail má plný text (náhradní zásobování) a často XLSX přílohu „Seznam dotčených odběrných míst“ (sloupce Kraj | Okres | Obec | Část obce | Ulice | č. o. | č. p. | … | kódy RÚIAN). Filtrovat regexem na `obec <název>` v titulku, dedup podle id z URL, zrušení = zmizení ze seznamu. robots.txt zakazuje jen `/cms/`.
   - **WFS (GeoServer) mapy odstávek** `https://uap.scvk.cz/geom/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=PPU_PU_OM&outputFormat=json` — GeoJSON bodů odběrných míst (1 bod = 1 dotčená adresa; `TYP` Prip/Prob, `ADRESA`, `DATUM_ZAHAJENI`, `DATUM_UKONCENI`, `NZASOBOVANI`, `ID` události, `ZDROJ_POCET`); podporuje `BBOX=lon1,lat1,lon2,lat2` a `CQL_FILTER=ADRESA LIKE '%…%'`; vrstva `NZV_POZICE` = živé pozice cisteren. GetCapabilities hlásí `Fees: NONE`, ale **není to publikované open-data API** (backend mapy, může se změnit) — používat šetrně (BBOX, interval ≥ 10 min, identifikující User-Agent) a dát SčVK vědět.
   - Pojistka bez kódu: registrace obecního úřadu do **„SMS a E-mail info“** SčVK (`https://portal.scvk.cz/smsinfo`, zpráva jen pro zaregistrovanou adresu). Podle § 9 odst. 5 zák. 274/2001 Sb. musí provozovatel havárii oznámit dotčeným obcím — zeptat se SčVK (info@scvk.cz) na strojový kanál a souhlas s WFS.
   - Doporučená implementace: HTML seznam jako primární zdroj (text, přílohy), WFS doplňkově (přesné adresy, polygon, cisterny); párovat podle obce + intervalu (id se neshodují). Pro jiné obce: profil obce ponese `vodarna: scvk | …` a adaptér na jejich provozovatele (jiné CMS, stejný princip).

## Úřední deska + povinně zveřejňované informace (P1)

Z WordPressu Vlastibořic: úřední deska je shortcode se seznamem dokumentů (vyvěšeno od–do, kategorie, PDF); „Obecní úřad informuje“ = články; stránka povinných informací v 14bodové struktuře; prohlášení o přístupnosti a zásady GDPR (platforma má). Požadavky: dokumenty s dobou vyvěšení (min. 15 dní u vyhlášek), archiv sejmutých, kategorie (vyhlášky, rozpočet, záměry, zápisy ZO, veřejné vyhlášky), přístupné PDF (štítek), RSS, odkaz na registr smluv, rozpočtová dokumentace (250/2000 Sb.) s lhůtami, export pro archiv. Redaktor píše, správce schvaluje (P2). Integrace s infokanálem: „vyvěsit + rozeslat“.

## Kvíz (hotovo 21. 10. 2026)

Obdoba hospodských kvízů pro občany: `/kviz` (úvod s výběrem oblastí), `/kviz/otazka`, `/kviz/vysledek`,
`/kviz/skore` (skóre po oblastech celkem i od posledního resetu), `/kviz/reset` (potvrzení). Správa `/sprava/kviz`
(role `kviz` nebo `web`, admin vše): kategorie a otázky s úspěšností hráčů, vypnutí/zapnutí otázky, ruční načtení balíků.

- **Banka otázek v YAML:** veřejné balíky `kviz-otazky/*.yml|yaml` v repozitáři, balíky obce mimo repozitář
  (`KVIZ_BALIKY=/cesta[,/další]`). Formát: `kategorie` (slug), `nazev`, `ikona`, `otazky: [{id, otazka, odpovedi: 4×
(první správná), obtiznost 1–5, vysvetleni, zdroj}]` (popis v `kviz-otazky/README.md`). Ověření zodem (právě 4
  různé odpovědi, obtížnost 1–5, id jedinečné napříč balíky). Import při každém startu a tlačítkem ve správě,
  idempotentně podle `id`: změny se propíší, otázka chybějící v balíku dostane `v_baliku = false` (historie odpovědí
  zůstává); **soubor s chybou se přeskočí celý a jeho otázky se nedeaktivují**. Výsledek posledního importu (vč.
  chyb) je ve správě. Pořadí kategorií: obec, region, okres, kraj, cr, eu, svet, priroda, dejiny, vesmir-veda, cestina,
  kultura, sport, pak ostatní podle názvu (jediné, co je v kódu natvrdo — kategorie samy přicházejí z YAML; kategorie,
  která z balíků zmizí, se hráčům přestane nabízet, její historie zůstává).
- **Hráč:** přihlášený = skóre u účtu (`kviz_hraci.uzivatel_id`); nepřihlášený = náhodné UUID v cookie `mo_kviz`
  (HttpOnly, Path=/kviz, 1 rok), která vzniká až odesláním „Začít kvíz“ (nezbytná cookie pro funkci, o kterou si
  návštěvník řekl — uvést v zásadách cookies). Má-li přihlášený v prohlížeči anonymní cookie, odpovědi se přesunou
  k účtu (účet bez rozehrané otázky převezme i ji) a cookie se smaže. Zakládání anonymních hráčů je omezené na
  30 / 15 min z jedné IP.
- **Odpovědi se míchají** při každém výběru otázky (`kviz_hraci.poradi`, stejné při obnovení stránky); server
  dostává pozici tlačítka a sám ji převede. Odpověď na jinou než rozehranou otázku (stará záložka, dvojklik) se
  nezapočítá. Bez JS vše funguje (POST → 303 → GET); `public/js/kviz.js` přidává klávesy A–D / Enter a fokus.
- **Řazení otázek** (`src/moduly/kviz/vyber.ts`, čistá funkce s testy):
  1. Kola po 10 otázkách. Cílová obtížnost kroku = profil `[1,1,2,2,2,3,3,4,4,5]` + posun z předchozího kola
     (≥ 80 % správně → +1, ≤ 40 % → −1, jinak 0; omezeno na 1–5). První dvě otázky kola mají cíl nejvýš 2 —
     nikdy se nezačíná těžkou, ani po výborném kole.
  2. Otázky zodpovězené v tomto kole a právě zobrazená se neopakují, dokud je z čeho brát.
  3. Přednost: neviděné → naposledy zodpovězené špatně → naposledy správně. V každé skupině nejdřív přesná
     obtížnost, pak ±1 (na začátku kola max. 2); když nic, celá banka s nejbližší obtížností.
  4. Ve vybrané množině se střídají kategorie (ne stejná dvakrát za sebou, je-li výběr) a vybírá se náhodně;
     u „správně zodpovězených“ jen z nejdéle neviděných (čtvrtina, aspoň 3).
     Hráč může na úvodu zvolit jen některé oblasti; nové „Začít“ zahájí nové kolo.
- **Skóre:** průběžné = od posledního resetu (`kviz_hraci.reset_at`); reset nic nemaže, jen posune počátek.
- **Kalibrace:** ve správě „správně napoprvé“ = podíl hráčů, kteří otázku trefili při prvním setkání; od 10 hráčů
  návrh obtížnosti (≥ 85 % → 1, ≥ 70 % → 2, ≥ 50 % → 3, ≥ 30 % → 4, jinak 5). Obtížnost se mění v YAML.
- **Ruční otázky** (jen `spravce`/admin): formulář ve správě (kategorie ze seznamu nebo nová — slug, název, ikona;
  otázka, správná + 3 špatné odpovědi, obtížnost, vysvětlení, zdroj), ověření stejným zod schématem jako YAML.
  Uloží se s `rucne = true`, `balik = 'rucne'` a id `<kategorie>-r<číslo>` (číslo = maximum v kategorii + 1, pod
  advisory zámkem). **Import YAML ruční otázky nikdy nevyřadí ani nepřepíše**; otázka z balíku se stejným id se
  přeskočí a ve správě se vypíše jako kolize. Ruční otázky jde upravit (audit `kviz.otazka_upravena`), vypnout jako
  ostatní a stáhnout jako YAML (`/sprava/kviz/<kategorie>/rucne.yml`) pro přenos do balíku obce (před vložením
  změnit id). Audit `kviz.otazka_pridana`, `kviz.kategorie_pridana`. Vyhrazené slugy: hraci, nova, otazka, import, rucne.
- **Statistiky hráčů** (jen `spravce`/admin, `/sprava/kviz/hraci`): souhrn (celkem, s účtem, anonymní, aktivní za
  7 a 30 dní podle `posledni_at`) a tabulka hráčů s přezdívkou účtu nebo „anonymní hráč #`cislo`“ (krátké pořadové
  číslo, nikoli id z cookie), skóre celkem a od resetu, nejčastější oblast a nejsilnější oblast (od 3 odpovědí),
  řazení serverově `?radit=hrac|odpovedi|skore|reset|posledni&smer=asc|desc`, stránkování po 50. Žádné kontakty.
- Tabulky `kviz_kategorie`, `kviz_otazky`, `kviz_hraci`, `kviz_odpovedi` (migrace 0011, také přidává roli `kviz`; 0012 přidává `rucne` a `cislo`).
- Zbývá: úklid dlouho neaktivních anonymních hráčů (např. po roce), hraní ve skupině / soutěž, výsledkové tabulky.

## Elektronická podatelna (hotovo 21. 10. 2026)

Veřejný formulář `/podatelna` pro podání bez elektronického podpisu a bez přílohy (náhrada formulářů typu Contact
Form 7 na starých webech obcí). Zapíná se `moduly.podatelna: true`.

- **Formulář:** jméno a příjmení, doručovací adresa (ulice, obec, PSČ — povinné), telefon a e-mail (nepovinné),
  předmět, text, potvrzení pravdivosti a informace o zpracování údajů s odkazem na zásady (právní základ čl. 6 odst. 1
  písm. c) a e) GDPR, ne souhlas). Obyčejný POST → přesměrování → GET, funguje bez JavaScriptu; chyby u polí přes
  `aria-invalid` + `aria-describedby` a souhrn s odkazy na pole. Stránka připomíná § 37 odst. 4 správního řádu
  (podání bez podpisu, které je úkonem v řízení, je nutné do 5 dnů potvrdit) a datovou schránku obce.
- **Ochrana:** CSRF (globálně), limit 5 podání / 15 min z jedné IP (`app.limity.podani`), past na roboty (skryté pole
  `web`; vyplněné = stejná odpověď jako člověku, ale nic se neuloží ani neodešle). Předmět se vždy převede na jeden
  řádek (jde do hlavičky e-mailu).
- **Zpracování:** podání se nejdřív uloží (`pod_podani`, číslo `EP-<rok>-<pořadí>` po pražském roce, pořadí pod
  transakčním zámkem), teprve pak odejdou e-maily: na adresu podatelny (`podatelna.email` → `obec.kontakt.epodatelna`
  → `obec.kontakt.email`) s Reply-To na podatele a podateli automatická zpráva o doručení s číslem podání („přijetí
  potvrdí úřad následující úřední den podatelny“). Selhání pošty podání neztratí — zapíše se k němu a správa ho ukáže.
- **Správa** `/sprava/podatelna` (jen `spravce` a `admin` — osobní údaje): nevyřízená / všechna, detail, interní
  poznámka (např. č. j. ve spisové službě), označit vyřízené / vrátit; vše do auditu. Dlaždice na `/sprava` s počtem
  nevyřízených.
- **Doba uchování:** `podatelna.uchovani_let` (výchozí 5 let — častá skartační lhůta pro podněty a žádosti
  občanů ve spisových plánech obcí, ověřit; obec ji má nastavit podle svého spisového a skartačního plánu). Ke každému
  podání se uloží `uchovat_do`; **nic se nemaže automaticky** — po lhůtě se podání ve správě jen označí („po době
  uchování“) a vyřazuje ho úřad ve skartačním řízení (zák. č. 499/2004 Sb.). Podání z formuláře je zároveň
  doručené e-mailem do spisové služby úřadu; aplikace spisovou službu nenahrazuje.

## Rezervace + platby (P1)

Z Rezervací Vlastibořic (nejrozsáhlejší modul): zdroje (sál, posilovna, hřiště, štěpkovač) s kalendářem denním/týdenním, kapacita > 1 (posilovna, počet osob), celý den vs. čas, opakování (série), schvalování úřadem (karty), ceník rezident/nerezident (rezervace úřadu = 0), ruční sleva; **měsíční vyúčtování** = „Výzva k úhradě“ (obec není plátce DPH, žádné faktury), PDF, QR platba (SPD), VS, veřejná stránka platby tokenem, potvrzení o zaplacení, splatnost 14 dní, cron 1. den měsíce, SMS fallback bez e-mailu; report pro účetní (rozpočtová skladba, pohledávky, CSV/PDF); předprodej vstupenek bez registrace (QR, storno 96 h, platba na místě, VIP, pokladní listina); evidence přístupů k zámkům (TTLock: PIN/otisk/čip/eKlíč) a proces aktivace posilovny; spolujízda (jízdy, poptávky, odběry, počítadlo); klimatizace/SMS připomínky topení. Zákon: 128/2000 Sb. (záměry), účetnictví obce. Doporučené pořadí: kalendář + schvalování → ceník → vyúčtování/QR → zámky → předprodej → spolujízda.

## Knihovna (P2)

Z eKnih: katalog volných e-knih (4 468, filtr jazyka), čtečka v prohlížeči (epub.js vendorované), police, rejstřík autorů, stahování jen pro přihlášené, předčítání (Piper TTS sidecar), statistiky agregované, právní pojistka (patička s kontaktem pro námitku). Python kód se nepřenáší; v platformě by šlo o modul nad stejným indexem (indexer ponechat).

## Společné (P1)

- Dashboard úřadu se statistikami (jen agregáty), jednotná administrace, dlaždice podle rolí.
- Návody občanům (PDF z HTML, pozor na font DejaVu v headless Chrome — zkušenost).
- Zálohy (cron `pg_dump`, viz INSTALACE), monitoring `/healthz`, aktualizace obrazu.
- Značka: „Moje obec“ (zkontrolováno TMview + domény 9/2026; „eObec“ je zapsaná známka Asseco — nepoužívat).
