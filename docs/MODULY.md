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

**Číslo účtu (22. 10. 2026, migrace 0017):** `uzivatele.cislo` (int, unikátní, sekvence `uzivatele_cislo_seq`) =
id uživatele v MůjÚčtu a v aplikacích rezervace/eKnihy; převedené účty mají číslo z MůjÚčtu, nové další volné.
V claims jako `mujucet_id`. Navíc `rezident_posouzen_at`/`rezident_posouzen_by` (číslo účtu správce) a `navic jsonb`
(údaje MůjÚčtu, které platforma zatím nepoužívá: `zdroj`, `barva`, `ikona`, `eknihy_sms`, `ekey_email_odmitnut`,
`rezident_avizo_at`, `hlavni_role`). Převod viz `docs/PREVOD.md`.

**OIDC klienti aplikací obce:** registrují se při startu z env — `OIDC_REZERVACE_SECRET` → klient `rezervace`,
`OIDC_EKNIHY_SECRET` → `eknihy`, případně `OIDC_KLIENTI` (JSON pole `{client_id, client_secret, nazev?,
redirect_uris?, post_logout_redirect_uris?, auth_metoda?}`, má přednost). Výchozí `redirect_uri`
`<BASE_URL>/<klient>/prihlaseni/callback`, `post_logout_redirect_uri` `<BASE_URL>/`, důvěryhodní (bez obrazovky
souhlasu), `token_endpoint_auth_method` `client_secret_basic` (nebo `client_secret_post` přes `auth_metoda`),
ID token **ES256**, PKCE povinné. Klient, který z env zmizí, se nemění (vypíná se `oidc_klienti.aktivni`).

**Claims** (scope → claims; vše v **userinfo** `/oidc/me`, ID token nese jen `sub` + standardní): `profile` → `name`,
`given_name`, `family_name`, `nickname`, `preferred_username`, `updated_at`; `email` → `email`, `email_verified`;
`phone` → `phone_number` (E.164), `phone_number_verified`; `obec` → `role` (pole), `rezident`, `cast_obce`,
`mujucet_id`.

**Odhlášení z aplikace:** aplikace pošle prohlížeč na `/oidc/session/end?client_id=…&post_logout_redirect_uri=<BASE_URL>/`
(nebo s `id_token_hint`); potvrzovací stránka se odešle sama a ukončí **OIDC session i sezení platformy** (`mo_sezeni`).

**Interní API pro aplikace** (`src/moduly/ucty/interni.ts`): hlavička `x-api-secret` = `INTERNI_API_SECRET`
(porovnání v konstantním čase; bez env = vypnuto, 404). Požadavek s `X-Forwarded-For` (přišel přes reverzní proxy) = 404
— aplikace volají platformu po vnitřní síti (`http://platforma:3000`).

- `GET /api/interni/uzivatel/:cislo` → profil `{sub, cislo, mujucet_id, name, given_name, family_name, nickname, email,
email_verified, phone_number, phone_number_verified, cast_obce, rezident, rezident_posouzen_at, rezident_posouzen_by,
role[], gdpr_souhlas_at, blokovan, vytvoren_at}`; neznámé číslo 404.
- `GET /api/interni/uzivatele?role=spravce,admin` → `{uzivatele: [profil…]}` — neblokované účty s některou z rolí
  (přesná shoda, admin se ke „spravce“ nepřidává sám); bez platné role 400.
- `POST /api/interni/uzivatel/:cislo/rezident` `{rezident: bool, kdo: <číslo účtu správce>}` → `{ok: true, …profil}`;
  `kdo` musí být neblokovaný admin nebo správce (jinak 403); zároveň nastaví posouzení rezidenta; audit `sprava.rezident`.

### Stránka Můj účet (hotovo 22. 10. 2026 — `src/moduly/ucty/ucet-karty.ts`, `ucet-aplikace.ts`, migrace 0021)

Náhrada aplikace MůjÚčet: `/ucet` sdružuje všechna nastavení účtu, karty podle zapnutých modulů obce (vypnutý modul
= karta zmizí, aplikace neodpoví = „teď nedostupné“, zbytek funguje):

- **Osobní údaje** (jméno, příjmení, přezdívka, část obce), e-mail a heslo (po čerstvém ověření), **telefon** — žádost
  `/ucet/telefon` (po čerstvém ověření, jedna čekající na účet) → e-mail správcům → `/sprava/ucty/zmeny-telefonu`
  (role správce) schválí (telefon účtu + odběratele, `telefon_overen_at` se vynuluje, SMS na nové číslo) nebo zamítne
  (SMS na staré s výzvou ozvat se úřadu). SMS jdou frontou infokanálu (`app.infokanalOdchozi`), bez něj přímo bránou.
- **Odběr hlášení**: odběratel podle `uzivatel_id`, jinak telefonu; kanál `sms`/`smisene`, kategorie (optouty),
  přihlášení jedním klikem (telefon ověřen přihlášením), zrušení odběru.
- **Rezervace** z aplikace (`APLIKACE_REZERVACE_URL`, `x-api-secret: INTERNI_API_SECRET`, timeout 4 s):
  `GET /api/sso/summary/:cislo` (počty, `upcoming`, `gymStatus`, přístupy, `ekeyEmail`, `ekeyWait`),
  `GET /api/sso/platby/:cislo` → `/ucet/platby`, `POST /api/sso/ekey/:cislo` (eKlíč), `POST /api/sso/mirror/:cislo`
  po změně telefonu. E-mail TTLock jako kontaktní jen se souhlasem (zatržítko u eKlíče nebo nabídka Ano/Ne).
- **Spolujízda** (počty ze souhrnu), **eKnihy** (opt-in `uzivatele.navic.eknihy_sms` pro avízo novinek).
- **Soukromí**: datum GDPR souhlasu, export `GET /ucet/moje-udaje.json` (profil bez hesla, odběr bez tokenu, změny
  telefonu, souhrn rezervací, záznamy auditu), žádost o výmaz `POST /ucet/vymaz` (e-mail správcům, výmaz dělá úřad).

## Infokanál (P0 — datový model a UI hotové; výstrahy P1)

**Převzato z VlastiKanálu:**

- Odběratel: jméno, telefon a/nebo e-mail, část obce, **preference kanálu** (vše SMS / smíšené = důležité SMS a ostatní e-mail / vše e-mail s krizovými SMS), **kategorie s opt-outem** (povinné: krizové, obecná hlášení; odhlásitelné: kultura, sport, služby, počasí, elektřina, voda), evidence souhlasu, zdroj (web, SMS, úřad, import, účet).
- Přihlášení k odběru veřejně s OTP; přihlášený občan se stejným telefonem bez dalšího kódu; odhlášení odkazem v patičce e-mailu; správa odběru kódem bez účtu. Přidání odběratele úřadem (senior osobně na úřadě). **P1:** SMS `START Jméno` / `STOP` na číslo obce (příchozí SMS přes webhook brány), hromadný import z CSV.
- Hlášení: SMS text (bez diakritiky, prefix obce, počítadlo segmentů), e-mail (předmět, text, HTML s vloženými obrázky — P1 editor), volitelně článek na web (P1: publikace na WordPress REST API nebo vlastní úřední deska). Cílení: všem / části obce / vlastní seznam (P1) + ad-hoc kontakty. Krizové hlášení = oba kanály všem bez ohledu na preference. „SMS jen kontaktům bez e-mailu“ šetří SMS. Plánované odeslání. Přílohy (P1).
- **Fronta:** worker posílá po jedné zprávě s prodlevou (konfigurovatelné tempo — u telefonu jako brány 8–20 s kvůli FUP operátora, u komerční brány krátce; krizové nejrychleji), e-maily a SMS ve dvou nezávislých proudech, 3 pokusy, stav v DB (restart nic neztratí), zastavení rozesílky úřadem. Doručenky: polling à 5 min + webhook. Poučení: SMS čítač se dlouho drží na 0, protože nejdřív jdou e-maily — v UI to říct.
- **SMS brána:** řešení s telefonem na úřadě (SMSGate) se nedá obcím oficiálně nabízet → abstrakce poskytovatele (viz níže). Pozor na UCS-2: typografické pomlčky a uvozovky převádět na ASCII, jinak 70 znaků/SMS.
- Statistiky jen jako agregáty (žádná jména) — P1 dashboard.

### Přechod z VlastiKanálu (hotovo 22. 10. 2026)

- **Převod dat:** `src/scripts/prevod-vlastikanal.ts` (návod v `docs/PREVOD.md`) — odběratelé, kategorie, opt-outy,
  historie hlášení se souhrnem počtů příjemců (`ik_hlaseni.souhrn`; jednotliví příjemci se nepřevádějí).
  Převedená hlášení jsou `hotovo`/`zruseno` a nikdy se znovu nerozesílají.
- **Interní API** (aplikace obce po vnitřní síti, hlavička `x-api-secret` = `INTERNI_API_SECRET`, požadavek přes
  proxy s `X-Forwarded-For` = 404, bez env vypnuto):
  - `POST /api/interni/odeslat` `{prijemci:[{telefon?,email?}], sms?, email?:{predmet,text,html?}, zdroj, bezPrefixu?}`
    → `202 {id, sms, email, zkraceno}`. Odchozí fronta `ik_odchozi` (vlastní worker, oddělený od hromadných hlášení):
    až 5 pokusů s rostoucím odkladem, Retry-After brány, doručenky webhookem i pollingem. SMS dostane předponu obce
    (`texty.sms_prefix`, pokud ji text nemá), bez diakritiky, nad 459 znaků se zkrátí (`zkraceno: true`). Audit
    `infokanal.interni_odeslani`. Stav dávky: `GET /api/interni/odeslat/:id`.
  - `GET /api/interni/odber?telefon=` → `{odebira, kanal:'sms'|'mixed'|'email', email?}`.
- **Příchozí SMS** (webhook brány na `/webhook/sms/<tajemství>`, stejná adresa jako doručenky; SMSGate událost
  `sms:received`): `START [jméno]` přihlásí (souhlas z registrační SMS, ověřeno číslem), `STOP` odhlásí, obojí
  s odpovědní SMS; `ODVOZ <cíl>` se předá rezervacím (`POST APLIKACE_REZERVACE_URL/api/sms/prichozi`, nebo
  `SPOLUJIZDA_HOOK_URL`, tělo `{phone, dest, text}`, hlavičky `x-hook-secret` = `SPOLUJIZDA_HOOK_SECRET`,
  `x-api-secret`); bez cíle odpověď „napište i cíl“; při nedostupnosti rezervací e-mail správcům. Ostatní SMS
  → e-mail správcům (role admin/spravce s e-mailem + `INFOKANAL_NOTIFY`).
- **SMSGate ostře:** webhooky (`sms:received`, `sms:delivered`, `sms:failed`), volitelný podpis `X-Signature`
  (`SMSGATE_WEBHOOK_KLIC`), registrace skriptem `src/scripts/smsgate-webhook.ts`.
- **Hlídání brány** (`brana.ts`, cron à 10 min, jen při SMSGate): `lastSeen` telefonu > `BRANA_LIMIT_MIN` (60) →
  e-mail `BRANA_NOTIFY` (jinak správci) s počtem čekajících SMS, připomínka à 12 h, po obnovení „zase funguje“;
  cloud nedostupný > 2 h → jedno upozornění. Stav v `nastaveni.infokanal_brana`.

### SMS brány — abstrakce a adaptéry (P0)

| Poskytovatel | Stav                                | Auth                                  | Doručenky                                                      |
| ------------ | ----------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `konzole`    | hotovo (vývoj, testy)               | —                                     | vždy „doručeno“                                                |
| `smsgate`    | hotovo (ostře od přechodu VK)       | Basic                                 | polling `GET …/message/<id>` + webhook `sms:delivered/failed`  |
| `smsbrana`   | podle dokumentace, naživo neověřeno | login + time + salt + md5(auth)       | polling `action=inbox` (`stahniDorucenky()`), PUSH webhook     |
| `gosms`      | podle OpenAPI, naživo neověřeno     | OAuth2 client_credentials (token 1 h) | `GET /api/v1/messages/{id}`, webhook (pole událostí)           |
| `smsmanager` | podle dokumentace, naživo neověřeno | hlavička `x-api-key` (JSON API v2)    | `GET rest-api…/v1/message?id=`, webhook s HMAC-SHA256 podpisem |

Ceny (10/2026, bez DPH, orientačně): SMSbrána ~1,08 Kč (s bonusem ~0,89), GoSMS „od 0,41 Kč“ u velkých objemů, SMS Manager 0,89 Kč v pásmu 5–10 tis./měs. (vlastní textový odesílatel +500 Kč/měs.). Doporučení pro obce: začít SMS Managerem nebo SMSbránou (prepaid, bez paušálu). **Úkol P1:** s první obcí ověřit vybraný adaptér naživo, doplnit cron pro `stahniDorucenky()` u SMSbrány, SMS `START/STOP` přes příchozí zprávy.

### Automatické výstrahy (hotovo 22. 10. 2026 — `src/moduly/infokanal/vystrahy/`, migrace 0019)

**Implementace:** `VystrahySluzba` (`sluzba.ts`) + parsery `chmu.ts`, `scvk.ts`, texty `texty.ts`, časy `cas.ts`
(pražské pásmo, noční klid). Tabulka `ik_vystrahy` (zdroj `chmu|cez|scvk`, `externi_id` = „jev|stupeň“ / id odstávky /
id události SčVK, stav `ceka|odeslano|zahozeno|preskoceno`, první `hlaseni_id`, `pripomenuto_at`, `zruseno_at`, kdo
rozhodl) a `ik_vystrahy_zdroje` (poslední úspěch/chyba, `chyba_od`, `alarm_at`, u ČHMÚ razítko zpracovaného souboru).
Hlášení vznikají přes `InfokanalSluzba.zalozHlaseni` s `zdrojAutomatu`, `dulezite: true` (smíšení odběratelé SMSkou)
a kategorií `pocasi` / `elektrina` / `voda` (odhlásitelné); červená ČHMÚ = kategorie `krizove`, `krizove: true`.
Cílení ČEZ/SčVK: `cil='casti'` s dotčenými částmi + `''` (odběratelé bez vyplněné části); všechny části = celá obec.

- **Konfigurace** `obec.yml`: `vystrahy: { chmu: { orp, oblast }, cez: { kod_obce }, scvk: { obec } }` — chybějící
  zdroj je vypnutý, prázdný klíč (`cez:`) zapnutý s výchozími hodnotami (`orp` → `obec.orp_cisorp`, `kod_obce` →
  `odstavky.cez.kod_obce` / `obec.kod_obce`, `scvk.obec` → `obec.kratky_nazev`). Env `VYSTRAHY=0` vypne plánovač,
  `VYSTRAHY_NOTIFY` = další adresy pro e-maily (vedle rolí admin a spravce s e-mailem).
- **Plánovač** (Europe/Prague, `protect`): ČHMÚ `*/10`, ČEZ `5 7,15` + připomínka `0 17`, SčVK `7,27,47` +
  připomínka `2 17`. ČEZ data bere z `OdstavkySluzba` modulu odstavky (stejná keš 1 h, po 429 pauza 3 h) — žádné
  dotazy navíc; bez modulu odstavky si vytvoří vlastní instanci nad stejným uložením.
- **Stránky:** veřejně `/infokanal/vystrahy` (rozeslané a stále platné), správa `/infokanal/sprava/vystrahy`
  (role redaktor; seznam se zdrojem, stavem a odkazem na hlášení, stav zdrojů), detail `/…/vystrahy/:id` s tlačítky
  **Rozeslat odběratelům** / **Zahodit** u čekající žluté (zahození = jen stav; rozeslání je atomické).
- **Odchylky od VlastiKanálu:** SčVK porovnává seznam obcí v titulku přesně (ne regex na „obec X“ — titulek může
  znít „obec Hrubá Skála, Troskovice, část obce Jivina“, kde Jivina není naše); upozornění na výpadek zdroje se
  počítá od začátku nepřetržitého selhávání (i když zdroj nikdy nefungoval); připomínky neovlivňují stav zdroje.
- **Testy:** `test/vystrahy.test.ts` nad uloženými odpověďmi v `test/fixtures/vystrahy/` (výřez CAP z 31. 7. 2026,
  výpis adresáře ČHMÚ, odpověď bezstavy.cz, výřezy seznamů a detailu SčVK), pevné hodiny a podstrčený fetch.

**Původní rozbor (návrh):**

Převzaté chování z VlastiKanálu (v provozu od 10/2026): zdroj se polluje cronem, události se dedupují podle klíče, žlutá/informační → jen e-mail správcům s tlačítkem „Rozeslat“, oranžová/odstávka → rozešle se samo (v noci 22–6 h naplánovaně na 6:30), červená → krizová zpráva všem; den předem připomínka; zrušení/změna termínu → další zpráva; cílení na dotčené části obce; při výpadku zdroje > 24 h jedno upozornění; veřejný přehled `/infokanal/vystrahy`; vypínač v konfiguraci.

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

## Odstávky elektřiny ČEZ na webu (hotovo 21. 10. 2026)

Modul `odstavky` (`src/moduly/odstavky/`, zapíná se `moduly.odstavky`): plánované odstávky elektřiny ČEZ Distribuce
jako **přístupný text** místo obrázkového banneru `ppo.cezdistribuce.cz/ovm/<klíč>/b/728`, který obce dávají na web
(text v obrázku čtečka nepřečte a obrázek z cizího serveru prozrazuje ČEZ každého návštěvníka).

- **Data:** stejný neoficiální zdroj jako výstrahy výše (`api.bezstavy.cz/cezd/api/inspecttown/<kód obce>`). Stahuje
  **server** nejvýš jednou za hodinu (cron :11 + po startu, jsou-li data starší než hodina); po **HTTP 429** pauza 3 h
  (nebo `Retry-After`), při chybě/neznámém tvaru odpovědi zůstávají poslední známá data. Stav (poslední úspěch, chyba,
  odstávky) je v `nastaveni.odstavky_cez` — přežije restart, žádná migrace. Časy API jsou skutečné UTC (ověřeno proti
  PDF: `08:00Z` = „od 9:00“), zobrazují se v pražském čase.
- **Titulka:** karta „⚡ Plánované odstávky elektřiny“ hned pod rychlými odkazy, nad aktualitami (na mobilu tedy také
  nad nimi): termín od–do, stav (probíhá / zrušena + vysvětlení), stručně části obce a č. p. (max. 8, „a dalších N“),
  `<details>` „Všechna odběrná místa“ (č. p., č. ev., parcely), odkaz „Oznámení ČEZ (PDF)“ (jen odkaz na
  `cdn.bezstavy.cz`, nic se nenačítá předem), „Další informace na webu ČEZ Distribuce“, „Podrobnosti a historie“ a čas
  ověření údajů. **Bez odstávky se na titulce nezobrazuje nic** — prázdný řádek by na každé návštěvě ubíral místo nad
  zprávami a informace „nic se neděje“ nemá hodnotu; stav je vždy na `/odstavky`.
- **Stránka `/odstavky`:** nadcházející a probíhající, historie posledních 30 dní (proběhlé a zrušené), zdroj a čas
  ověření, upozornění na nepovedenou aktualizaci.
- **Konfigurace (`obec.yml`):** `odstavky.cez.kod_obce` (prázdné = `obec.kod_obce`), `odstavky.cez.odkaz` = stránka ČEZ
  pro obec — odkaz `…/ovm/<klíč obce>/redirect` z banneru ČEZ (klíč patří jen do `obec.yml` instalace, ne do repa);
  prázdné = obecná `https://www.cezdistribuce.cz/odstavky`.
- **Obce mimo ČEZ Distribuce** (EG.D — jižní Morava a jižní Čechy; PREdistribuce — Praha) modul nezapínají: API
  bezstavy.cz pokrývá jen ČEZ. Jiný distributor = nový převodník v `cez.ts`-stylu, pokud bude mít použitelný zdroj.
- **Navazuje:** automatické rozesílání odstávek infokanálem (P1 výše) může použít stejný převod `prevedOdpoved()`.

## Obecní web — akce propojené s rezervacemi (hotovo 22. 10. 2026)

Návrh a rozhodnutí: `docs/AKCE-PROPOJENI.md`. Jedna akce = jeden záznam obsahu typu `akce`; termín v rezervačním
systému (`REZERVACE_KALENDAR_URL`, položky `r<id>`, série `s<id>`, předprodej `e<id>`) se k ní připojí přes
`web_obsah.rezervace_ref`.

- **Synchronizace** (`src/moduly/web/akce-propojeni.ts`, cron à 10 min + při otevření správy): veřejný termín bez
  propojení → návrh propojení s podobnou akcí ve stejný den, jinak **koncept** akce (nikdy zveřejněný; vypíná
  `web.akce_koncepty: false`). Série = jeden koncept.
- **Správa → Akce → Akce ke zpracování** (`/sprava/web/akce/zpracovani`, role `web`, počet na dashboardu): nové
  koncepty (Doplnit a zveřejnit / propojit s existující / Jen v kalendáři), návrhy propojení, změněné termíny
  (Převzít termín / Ponechat), zrušené rezervace (Odpojit), seznam termínů „jen v kalendáři“. Vše s auditem
  (`web.akce_propojeni`, `web.akce_ignorovani`, `web.akce_termin` …).
- **Editor akce:** „Propojit s rezervací“, „Zobrazit i v Aktualitách jako pozvánku“ (`v_aktualitach`), kategorie.
- **Veřejný web:** termín propojený se zveřejněnou akcí se v `/akce` a na úvodu neukazuje dvakrát (místo něj akce
  z webu, u série s nejbližším výskytem); pozvánky jsou v `/aktuality`, v kategoriích i v RSS (řazení podle data
  zveřejnění, odkaz `/akce/<slug>`).
- **Rozesílka z příspěvku:** u zveřejněné aktuality i akce tlačítko „Rozeslat infokanálem“ (jen se zapnutým
  infokanálem a rolí redaktor) → předvyplněné hlášení (`/infokanal/sprava/nove?obsah=<id>`), po odeslání
  `web_obsah.hlaseni_id` a „Rozesláno …, N příjemcům“ v editoru.
- **Statistiky úvodu:** každá dlaždice je odkaz; `obec.fakta[].odkaz` (cesta `/…` nebo `https://…`),
  `web.stat_zpravy_kategorie` (slug kategorie zpráv za měsíc), pět nejbližších akcí.

## Text dokumentů a vyhledávání v nich (hotovo 22. 10. 2026)

Zadání a rozhodnutí: `docs/HLEDANI-DOKUMENTY.md`. Každý nahraný dokument (příloha úřední desky, soubor ke stažení,
dokument v obsahu) dostane na pozadí **text**: z textové vrstvy PDF (`pdftotext`), u skenů přes **OCR**
(`pdftoppm` + `tesseract`, česky i anglicky), z Wordu/Excelu/PowerPointu/OpenDocumentu (ZIP/XML přímo v Node),
ze starého `.doc` (`antiword`) a z RTF. Obrázek nahraný jako dokument (sken JPG/PNG) jde rovnou do OCR; fotky galerií,
loga a videa se neindexují. Vše běží lokálně na serveru obce.

- **Data:** tabulka `soubory_text` (stav `ceka | zpracovava | hotovo | bez_textu | nepodporovano | chyba`, zdroj,
  text do `TEXT_MAX_ZNAKU`, počet stran, vrstva, chyba/poznámka, pokusy, priorita), generovaný `tsvector` + GIN;
  textová konfigurace `cs_bez` pro úryvky s diakritikou. Migrace 0015.
- **Worker** (`src/lib/text-fronta.ts`): jeden soubor po druhém, `nice -n 15`, atomické zabrání řádku, chyby 3× s
  odkladem 10 min, zaseknuté řádky po 40 min zpět do fronty, cron à 1 min + probuzení po nahrání. Čistá logika
  (rozhodnutí o vrstvě, parsování Office, příkazy) v `src/lib/text-souboru.ts`.
- **Hledání:** `/hledat` má zdroj „v dokumentech“ (úryvek s `<mark>`, odkaz na místo na webu: dokument desky,
  `/dokumenty#d-<id>`, stránka s odkazem na soubor); neveřejné a nikde nepoužité soubory se nehledají.
- **Správa:** `/sprava/web/text-dokumentu` (role `web`/`deska`) — stav fronty, chyby, bez textu, nepodporované,
  „Zpracovat znovu / teď“, hromadně „Zkontrolovat všechny dokumenty znovu“ a „Znovu jen chyby a bez textu“;
  štítky u dokumentů desky a souborů ke stažení; karta na dashboardu `/sprava`; hláška o vrstvě hned při nahrání
  PDF. Skript `src/scripts/text-souboru.ts` (`--chybejici | --vse | --jen-pdf | --znovu-chyby | --id …`).
- **Konfigurace:** `TEXT_SOUBORU`, `OCR_JAZYKY`, `OCR_MAX_STRAN`, `OCR_DPI`, `TEXT_MAX_ZNAKU`; nástroje jsou
  v obrazu Dockeru (mimo Docker doinstalovat, viz `INSTALACE.md`).
- Rychlost: text z vrstvy do sekundy, sken ~3–7 s na stranu (tesseract záměrně s jedním vláknem — se 4 vlákny
  OpenMP je pomalejší a vytíží celý server), paměť tesseractu ~150 MB — proto `mem_limit` 768 MB.

## Moduly obce — zapínání ve správě a aplikace za proxy (hotovo 22. 10. 2026)

- **Klíče:** `rezervace`, `predprodej`, `spolujizda` (části rezervací), `eknihy`, `infokanal`, `kviz`. Výchozí stav
  z `obec.yml` → `moduly` (`eknihy` bere i starší `knihovna`; `predprodej`/`spolujizda` výchozí `true`), změny ze
  **Správa → Moduly obce** (`/sprava/moduly`, jen role `admin`, audit `moduly.zmena`) v `nastaveni.moduly`.
  Bez migrace (tabulka `nastaveni` existuje; číslo 0016 zůstává volné).
- **Služba** `app.moduly` (`src/moduly/sluzby/sluzba.ts`): `zapnuto(klic)`, `stav()`, `nastaveno()`, `uloz()`,
  `dostupny(klic)`, `obecProSablony()`, `skryteCesty()`; keš 30 s, po uložení se zahodí. Skutečný stav =
  nastaveno ∧ dostupné ∧ zapnutý rodič. Dostupné: aplikace jen s `APLIKACE_REZERVACE_URL` / `APLIKACE_EKNIHY_URL`,
  platformní moduly jen když je `obec.yml` povolí (registrují se při startu; vypnutí za běhu nevyžaduje restart).
- **Vypnutý modul:** šablony dostávají `obec.moduly` podle skutečného stavu (menu, úvod, patička, mapa stránek,
  sitemap), menu webu se filtruje od odkazů na cesty vypnutých modulů (i absolutní na `BASE_URL`). Veřejné stránky
  (`/infokanal*`, `/kviz*`, `/rezervace*`, `/eknihy*`) vrací 404 „Tato služba není v obci zapnutá“. Zůstává:
  správa (`/infokanal/sprava`, `/sprava/kviz`) a odhlášení odběru odkazem z e-mailu (`/infokanal/odhlasit/…`).
  `obecStaticka` v šablonách = profil z obec.yml (karta správy na dashboardu zůstává).
- **`GET /api/moduly`** (veřejné, keš 30 s, CORS `*`) — tvar **zafixovaný** s aplikacemi (lišta rezervací a eKnih):

  ```json
  {
    "moduly": [
      { "klic": "rezervace", "nazev": "Rezervace", "url": "/rezervace/", "zapnuto": true },
      {
        "klic": "predprodej",
        "nazev": "Předprodej vstupenek",
        "url": "/rezervace/predprodej",
        "zapnuto": true,
        "rodic": "rezervace"
      },
      {
        "klic": "spolujizda",
        "nazev": "Spolujízda",
        "url": "/rezervace/spolujizda",
        "zapnuto": false,
        "rodic": "rezervace"
      },
      { "klic": "infokanal", "nazev": "Infokanál", "url": "/infokanal", "zapnuto": true },
      { "klic": "eknihy", "nazev": "eKnihy", "url": "/eknihy/", "zapnuto": true },
      { "klic": "kviz", "nazev": "Kvíz", "url": "/kviz", "zapnuto": true }
    ],
    "zapnuto": {
      "rezervace": true,
      "predprodej": true,
      "spolujizda": false,
      "infokanal": true,
      "eknihy": true,
      "kviz": true
    }
  }
  ```

  V `moduly` je vždy všech šest klíčů (`rezervace, predprodej, spolujizda, eknihy, infokanal, kviz`) v pořadí lišty,
  odkaz se kreslí jen u `zapnuto: true`. Obec (`/`) a Můj účet (`/ucet`) si aplikace přidávají samy. Název
  infokanálu z `texty.nazev_infokanalu`.

- **Proxy** (`src/moduly/sluzby/proxy.ts`, `node:http` bez další závislosti): háček `onRequest` před sezením
  platformy — tělo se nečte (formuláře, multipart 1:1), žádná cookie `mo_sezeni`, CSRF ani bezpečnostní hlavičky
  / CSP platformy (odpověď přes `reply.hijack`). Cesta se předává celá (s předponou), hlavičky `Host` (původní),
  `X-Forwarded-Host`, `X-Forwarded-Proto` (podle `BASE_URL`), `X-Forwarded-For` (= skutečná IP klienta podle
  `TRUST_PROXY_HOPS`, podvržené hodnoty klienta se zahodí), `X-Forwarded-Prefix: /rezervace|/eknihy`. `Set-Cookie`
  a `Location` beze změny; absolutní `Location` na vnitřní adresu aplikace se přepíše na relativní.
  `/rezervace` → 301 `/rezervace/` (totéž `/eknihy`). Vypnutý `predprodej`/`spolujizda` blokuje
  `/rezervace/predprodej*` / `/rezervace/spolujizda*`. Aplikace neodpoví / timeout `APLIKACE_TIMEOUT_MS`
  (60 s) → 502 „Služba je dočasně nedostupná“. WebSockety (Upgrade) se neproxují.
- Testy: `test/moduly-proxy.test.ts` (falešná aplikace na volném portu).

## Hlavička webu pro aplikace za proxy (hotovo 22. 10. 2026 — `src/moduly/sluzby/hlavicka.ts`)

Rezervace (vč. spolujízdy) a eKnihy vypadají jako stránky webu obce: stejná hlavička, hlavní plovoucí menu, patička,
pozadí s fotkami i skleněná karta obsahu; pod hlavním menu mají vlastní **podmenu**. Rozhodnutí Dušana 22. 10. 2026,
závazný kontrakt s aplikacemi v `/opt/vlastiborice/docs/HLAVICKA-APLIKACI.md` (mimo repozitář platformy).

- **`GET /api/interni/hlavicka?modul=rezervace|spolujizda|eknihy[&aktivni=/cesta]`** — interní API jako ostatní
  `/api/interni/*` (`x-api-secret: INTERNI_API_SECRET`, požadavek s `X-Forwarded-For` → 404). Aplikace přepošle
  hlavičku `Cookie` prohlížeče 1:1: z ní platforma pozná přihlášeného (sezení `mo_sezeni` → `req.uzivatel`, běžným
  háčkem jako u stránek) a velikost písma (`mo_velikost`). Odpověď `{ verze, html }`: `html` = celá stránka webu bez
  obsahu (layout.eta v režimu `it.shell`) se zástupnými komentáři `<!--HEAD-->` (konec `<head>`; shell nemá
  `<title>` ani `description`), `<!--PODMENU-->` (hned za hlavním menu) a `<!--OBSAH-->` (v `main.obal.aplikace >
.panel-hlavni`). Odkaz Přihlásit a pole `zpet` formuláře velikosti písma obsahují `__ZPET__` (aplikace nahradí
  všechny výskyty aktuální adresou). `verze` = otisk HTML. Keš 60 s podle (modul, cesta, uživatel, velikost písma),
  z keše = hlavička `x-hlavicka-kes: 1`; `cache-control: no-store`.
- **Jeden zdroj:** shell vykresluje tentýž `views/layout.eta` jako web přes `app.vykresli()` (`src/web/sablony.ts`,
  skládání dat layoutu sdílí `reply.view`); flash hláška ze sezení se v shellu nevypisuje ani nespotřebuje.
  Odhlášení v hlavičce = `POST /odhlaseni` s CSRF tokenem sezení z přeposlané cookie — token vzniká nad tímtéž sezením,
  takže formulář odeslaný z aplikace (stejná doména) projde (test `hlavicka.test.ts`).
- **Menu Moje obec:** položka webu (stránka s podřízenými odkazy na `/ucet`, `/rezervace/`, `/rezervace/spolujizda`,
  `/eknihy/…`) se filtruje podle zapnutých modulů; v shellu je aktivní podřízená položka s nejdelší shodou s `aktivni`
  (jinak první pod kořenem modulu).
- **Tlačítko A** (`.menu-admin`, `/sprava`, popisek „Administrace“) vpravo od poslední položky menu pro přihlášeného
  s jakoukoli správcovskou rolí (admin, spravce, web, deska, redaktor, ucetni, vstupne, kviz) — na webu i v shellu,
  v mobilním menu jako položka „Administrace“. Pevná barva `--menu-admin` (#c2410c, bílý text 7,5 : 1, bílý vnitřní
  rámeček, aby šla poznat i v oranžovém schématu).
- **Podmenu** (`.podmenu`, `.podmenu-in`, `.podmenu-znacka`, `.podmenu-seznam`, `.ma-rozbal > button[aria-expanded]
  - .podmenu-rozbal`, `.podmenu-vpravo`): světlý pruh `position: sticky`— na desktopu`top: calc(10px +
    var(--vyska-menu) + 8px)`přesně pod plovoucí pilulkou (výšku měří`public/js/web.js`, bez JS odhad z písma),
na mobilu `top: 0`a vodorovně posuvný řádek; rozbalené seznamy mají kontejner`.podmenu-in`mimo posuvný řádek,
aby je`overflow-x: auto`neořízl. Chování`.ma-rozbal`dává`public/js/app.js`(klik, Esc + fokus zpět, klik mimo,
odchod fokusu). Aktivní:`a[aria-current="page"]`i`button[aria-current]`.
- **`public/css/ramec.css`** = rámec webu vyčleněný ze `styl.css` (proměnné, html/body/.obal, .skip, .vh,
  .odkaz-tlacitko, pozadí, hlavička, pilulka vč. efektů, mobilní menu, .panel-hlavni, pás dárců, patička, podmenu,
  tlačítko A, tisk — celý rámec `display: none`). Nesmí stylovat obecné prvky obsahu (table, input, button, form,
  nadpisy, .karta, .tlacitko…). Web linkuje `ramec.css?v=` + `styl.css?v=` (dva `<link>`, oba s verzí v adrese),
  shell jen `ramec.css` + inline proměnné vzhledu. Aliasy pro aplikace: `--pismo-nadpisy` (= `--pismo-nadpis`),
  `--vyska-menu`, `--menu-admin`. Stránky OIDC provideru (odhlášení, chyba) linkují oba soubory.
- **Administrace:** „Správa“ se v textech jmenuje **Administrace** (`app.sprava`, `sprava.titulek`, drobky `← Administrace`,
  dokumentace API); adresa `/sprava` zůstává, `/administrace*` → 301 `/sprava*` (modul web).
- Testy: `test/hlavicka.test.ts` (endpoint, role, keš, CSRF odhlášení, ramec.css, kontrast, přesměrování).

## API pro integrace (hotovo 22. 10. 2026)

Obecné REST API `/api/v1` pro programy, které na web samy zapisují (sazba zpravodaje, kalendář, systémy úřadu).
Kód `src/moduly/api/`, migrace 0020, testy `test/api.test.ts`, dokumentace pro lidi `/api`, strojová `/api/openapi.json`
(OpenAPI 3.1, ručně v `openapi.ts` — při změně endpointu upravit i tam a na stránce).

- **Tokeny** (`api_tokeny`): Správa → **API a integrace** (`/sprava/api`, jen admin) — název, rozsahy `obsah:cteni`,
  `obsah:zapis`, `deska:zapis`, `infokanal:rozeslat`, `zpravodaj`; token (`wov_…`) se ukáže jen jednou, v DB je
  SHA-256; zrušení, poslední použití + počet; audit `api.token_zalozen/zrusen`. Ověření `Authorization: Bearer`,
  porovnání hashe v konstantním čase, limit 600 požadavků na token / 15 min, 30 neplatných pokusů z IP / 15 min.
  Multipart na `/api/v1` pustí brána v `web/nahravani.ts` jen s platným tokenem (`app.apiNahrani.over`).
- **Autor** obsahu a záznamů v auditu = uživatel, který token založil; audit má navíc id a název tokenu.
- **Příspěvky**: `POST /prispevky` (aktualita/akce/stránka; html se sanitizuje, markdown se převede `markdown.ts`),
  `PATCH /prispevky/:id` (jen obsah založený přes API), `GET /prispevky?zdroj=&externi_id=`, `GET /prispevky/:id`,
  vše přes `ObsahSluzba.uloz` (revize, audit). Bez `zverejnit: true` = koncept; zveřejněný + `zverejnit: false` =
  rozpracovaná změna. Kontroly jako ve správě (titulek, popis úvodního obrázku, alt obrázků v textu).
  **Idempotence:** `zdroj` + `externi_id` (unikátní index mezi nesmazanými) → opakovaný POST upraví.
- **Soubory** `POST /soubory` přes `SouboroveUloziste.uloz` (text/OCR do fronty). **Deska** `POST /deska`: minimální
  doba kategorie, žádné zpětné vyvěšení, nahrazení rozpočtových dokumentů jen s `potvrdit_nahrazeni` (jinak 409).
- **Rozeslání** `POST /prispevky/:id/rozeslat` = logika tlačítka „Rozeslat infokanálem“ (`infokanal/z-prispevku.ts`,
  společné se správou); SMS jen s `sms: true`.
- **Zpravodaj** `POST /zpravodaj` (docs/ZPRAVODAJ-API.md): metadata (zod) → aktualita v kategorii `zpravodaj`
  (zdroj `zpravodaj`, externi_id `rocnik-cislo`), tabulka `web_zpravodaj` (metadata jsonb, obyvatel, soubory).
  Úvod webu: `obyvatelZeZpravodaje()` nahradí fakt s popiskem „obyvatel“ z `obec.yml` (titulek „podle Zpravodaje …“),
  jen ze zveřejněného čísla. Akce z metadat → koncepty akcí (zdroj `zpravodaj`), duplicita = stejný den + podobný
  název; v seznamu „Akce ke zpracování“ nejsou (ten je pro termíny z rezervací) — jsou mezi koncepty správy webu.
- Zbývá: webhooky/čtení desky přes API, tokeny pro aplikace rezervací (stejný mechanismus), limit v DB při více
  instancích.

## Úřední administrace ve Správě (hotovo 22. 10. 2026 — `src/moduly/administrace/`)

Náhrada centrální Administrace MujÚčtu (dashboard, Schvalování, Statistiky). Bez migrace — používá sloupce
z 0017 (`rezident_posouzen_at/_by`, `navic`).

- **Dlaždice na `/sprava`** podle rolí: správce/admin Schvalování (počty žádostí, k posouzení, bez jména),
  Statistiky, Rezervace, Uživatelé rezervací, Spolujízda; správce i účetní Vyúčtování, Předprodej, Report,
  Ceník (odkazy do `/rezervace/admin/…`). Počty z `GET <APLIKACE_REZERVACE_URL>/api/admin/summary`
  (timeout 4 s); nedostupné rezervace = dlaždice bez čísla + hláška. Vypnutý modul rezervace = bez dlaždic.
- **`/sprava/schvalovani`** (správce): žádosti o rezervace a série z `GET /api/admin/approvals`, tlačítka
  Potvrdit/Zamítnout + poznámka → `POST /api/admin/approvals/reservation/:id {action, pozn, celaSerie, actorId}`;
  posilovna → `POST /api/admin/approvals/gym/:uid` (jen admin; aktivace až po zapsání evidence zámků).
  `actorId` = `uzivatele.cislo`. Nativně: účty se jménem bez posouzení rezidenta (✓ Rezident / Posouzeno — není
  rezident → `ucty.nastavRezident`, audit `sprava.rezident`) a účty bez jména (doplnění jména, audit
  `sprava.jmeno`).
- **Avízo správcům** (cron à 5 min, `REZIDENT_AVIZO`, výchozí zapnuto): nový účet se jménem bez posouzení
  z posledních 14 dní → jednou e-mail „⚠️ Nový účet: X — posuďte, zda je rezident“ adminům a správcům s e-mailem
  (frontou `ik_odchozi`, zdroj `sprava`; značka `navic.rezident_avizo_at`). Po posouzení ve Schvalování
  „✓ Vyřízeno: X — rezident ANO/NE“.
- **`/sprava/statistiky`** (správce): agregáty účtů (přihlášení z auditu `prihlaseni`), infokanálu (odběratelé,
  hlášení, SMS za měsíc z hlášení i interního API), rezervací (`/api/admin/summary`) a eKnih
  (`GET <APLIKACE_EKNIHY_URL>/api/statistiky`). Jediné konkrétní položky = názvy nejstahovanějších knih.
- **Klíč:** `x-api-secret` = `APLIKACE_API_SECRET`, jinak `INTERNI_API_SECRET` (rezervace ho přijímají
  v režimu `IDENTITA=platforma`, větev `pr-ucet-rez`; jinak nastavit `APLIKACE_API_SECRET` = `SSO_API_SECRET`
  rezervací).
- **Zatím chybí:** návštěvnost z logů NPM (MůjÚčet `pristupy.js` — potřebuje mount `npm/data/logs` do kontejneru
  platformy), týdenní úklid bezejmenných účtů (`uklid.js`), změny telefonu ke schválení.

## Rezervace + platby (P1)

Z Rezervací Vlastibořic (nejrozsáhlejší modul): zdroje (sál, posilovna, hřiště, štěpkovač) s kalendářem denním/týdenním, kapacita > 1 (posilovna, počet osob), celý den vs. čas, opakování (série), schvalování úřadem (karty), ceník rezident/nerezident (rezervace úřadu = 0), ruční sleva; **měsíční vyúčtování** = „Výzva k úhradě“ (obec není plátce DPH, žádné faktury), PDF, QR platba (SPD), VS, veřejná stránka platby tokenem, potvrzení o zaplacení, splatnost 14 dní, cron 1. den měsíce, SMS fallback bez e-mailu; report pro účetní (rozpočtová skladba, pohledávky, CSV/PDF); předprodej vstupenek bez registrace (QR, storno 96 h, platba na místě, VIP, pokladní listina); evidence přístupů k zámkům (TTLock: PIN/otisk/čip/eKlíč) a proces aktivace posilovny; spolujízda (jízdy, poptávky, odběry, počítadlo); klimatizace/SMS připomínky topení. Zákon: 128/2000 Sb. (záměry), účetnictví obce. Doporučené pořadí: kalendář + schvalování → ceník → vyúčtování/QR → zámky → předprodej → spolujízda.

## Knihovna (P2)

Z eKnih: katalog volných e-knih (4 468, filtr jazyka), čtečka v prohlížeči (epub.js vendorované), police, rejstřík autorů, stahování jen pro přihlášené, předčítání (Piper TTS sidecar), statistiky agregované, právní pojistka (patička s kontaktem pro námitku). Python kód se nepřenáší; v platformě by šlo o modul nad stejným indexem (indexer ponechat).

## Společné (P1)

- Dashboard úřadu se statistikami (jen agregáty), jednotná administrace, dlaždice podle rolí.
- Návody občanům (PDF z HTML, pozor na font DejaVu v headless Chrome — zkušenost).
- Zálohy (cron `pg_dump`, viz INSTALACE), monitoring `/healthz`, aktualizace obrazu.
- Značka: **Obecní web od Voltu 2.0** (od 22. 10. 2026; dříve „Moje obec“, které používají jiné produkty). „Moje obec“ zůstává jen jako název sekce služeb v menu obce. „eObec“ je zapsaná známka Asseco — nepoužívat.
