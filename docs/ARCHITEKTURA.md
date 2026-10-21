# Architektura

Rozhodnutí jsou zapsaná jako ADR (Architecture Decision Record): kontext → rozhodnutí → důsledky. Rozhodnutí 1–6 učinil vlastník projektu (Dušan Koutník) před začátkem etapy 0 a **neotvírají se znovu**; další jsou rozhodnutí vývojáře v etapě 0 s odůvodněním.

## ADR 1 — Identita přes standard: vestavěný OpenID Connect provider

**Kontext.** Prototyp ve Vlastibořicích měl vlastní SSO: HMAC podepsanou cookie na doméně obce, kterou čtou všechny aplikace. Fungovalo to, ale je to nepřenositelné (jedna doména, sdílené tajemství v každé aplikaci), nestandardní (žádný cizí software se nepřipojí) a bez revokace.

**Rozhodnutí.** Platforma obsahuje **OpenID Connect provider** postavený na certifikované knihovně [`oidc-provider`](https://github.com/panva/node-oidc-provider) (panva). Žádný Keycloak — obecní VPS nemá na Javu paměť a obec nemá na správu další služby lidi. Issuer je `<BASE_URL>/oidc`. **Primární přihlášení je telefon + SMS kód** (mnoho seniorů nemá e-mail), e-mail a heslo jsou volitelné. Interní moduly platformy i externí aplikace používají standardní Authorization Code flow s PKCE. Do budoucna se jako upstream poskytovatelé napojí Identita občana (NIA) a Bank iD.

**Důsledky.** Platforma je zároveň **klientem vlastního providera** (`openid-client`): přihlášení v aplikaci = přesměrování na `/oidc/auth`, přihlašovací obrazovky jsou „interakce“ providera (`/oidc/interaction/:uid`), po návratu vznikne aplikační sezení. Odhlášení = RP-initiated logout → odhlásí ze všech aplikací. Vlastní klient je označen jako důvěryhodný (bez obrazovky souhlasu), cizí aplikace souhlas dostanou. Volání sebe sama (token endpoint) jde přes `INTERNAL_BASE_URL`, ne přes veřejnou proxy.

## ADR 2 — Jedna databáze PostgreSQL, modulární monolit

**Kontext.** Čtyři SQLite aplikace si vzájemně zrcadlily uživatele přes interní API — křehké a duplicitní.

**Rozhodnutí.** Jedna kódová základna s moduly (`src/moduly/<modul>`), jedna databáze PostgreSQL. Modul = routy + služba + migrace + šablony; zapíná se v `obec.yml`. Obec je **konfigurace**, ne instalace.

**Důsledky.** Moduly sdílí tabulky jádra (`uzivatele`, `audit_log`) přímo, bez HTTP. Tabulky modulu mají prefix (`ik_` infokanál). Vypnutý modul se nenamountuje (žádné routy, žádné crony).

## ADR 3 — Nasazení „jeden balík na vlastní server“

**Rozhodnutí.** `docker-compose.yml` = aplikace + PostgreSQL 16 + Caddy (automatické TLS). Centrální multi-tenant hosting teď není cíl. Pro server Vlastibořic varianta `docker-compose.dev-server.yml` bez Caddy (za Nginx Proxy Managerem).

**Důsledky.** Aplikace nesmí nic předpokládat o cestě (`BASE_URL` je jediný zdroj pravdy), běží za reverzní proxy (`trustProxy`, `provider.proxy`), paměťové limity jsou v compose (`mem_limit`, menší `shared_buffers`).

## ADR 4 — Od začátku testy, zálohy, monitoring, dokumentace instalace

Vitest (jednotkové i HTTP testy proti skutečnému Postgresu), `/healthz` (kontroluje DB, vrací 503), CI (lint, typy, testy, build obrazu), `docs/INSTALACE.md` včetně zálohování.

## ADR 5 — Licence EUPL-1.2

Evropská veřejná licence v. 1.2, úředně přeložená do češtiny, kompatibilní s GPL/AGPL/MPL. Vlastník ji ještě potvrdí; do té doby se používá.

## ADR 6 — Vlastibořice = první instalace, bez přenosu dat

Produkční data se nekopírují; pracuje se s demo daty (`npm run seed`). Produkční aplikace běží dál beze změny.

---

## ADR 7 — Kysely místo Drizzle (rozhodnutí vývojáře)

**Kontext.** Zadání nechalo volbu mezi drizzle-orm/drizzle-kit a Kysely.

**Rozhodnutí.** **Kysely** + `pg`, migrace jako TypeScript soubory s **explicitním SQL** (`src/db/migrations`), typy tabulek psané ručně (`src/db/types.ts`).

**Odůvodnění.** (a) Kód veřejné správy má číst i člověk, který zná jen SQL — migrace jsou obyčejné `CREATE TABLE`, žádný generovaný DSL. (b) Kysely je jen typovaný stavitel dotazů bez „magie“ a bez vlastního formátu schématu; nic se negeneruje, nic se nesynchronizuje. (c) Menší závislost (jedna knihovna) a stabilní API. Cena: typy tabulek se udržují ručně vedle migrací — za to je schéma na jednom čitelném místě. Poučení z etapy 0: `Generated<ColumnType<…>>` Kysely nerozbalí, pro `DEFAULT now()` sloupce je zvláštní typ `TimestampGenerated`.

## ADR 8 — Šablony Eta, progressive enhancement

Eta (rychlé, TypeScript, automatické escapování, layouty). Všechny stránky fungují **bez JavaScriptu** (formuláře, přesměrování, žádné SPA); JS jen jako vylepšení. Žádné CDN ani externí skripty — obecní web nesmí posílat návštěvníky na cizí servery. Knihovny se vendorují přes npm.

## ADR 9 — Sezení aplikace v Postgresu, CSRF tokeny

`@fastify/session` s vlastním úložištěm v tabulce `sezeni` (odhlášení/blokace = smazání řádku, žádná „visící“ cookie). Každý formulář nese `_csrf` (`@fastify/csrf-protection`, tajemství v sezení). OIDC endpointy providera a webhooky mají vlastní ochranu (PKCE, client secret, tajná URL / podpis) a CSRF kontrole nepodléhají.

## ADR 10 — Abstrakce SMS poskytovatele

Rozhraní `SmsPoskytovatel` (`posli`, `stavDoruceni`, volitelně `zpracujWebhook`). Implementace: `konzole` (vývoj/testy), `smsgate` (sms-gate.app — telefon jako brána, jen pro vývoj), `smsbrana` (SMSbrána.cz, podle dokumentace SMS Connect), `gosms` (GoSMS.eu, OpenAPI), `smsmanager` (SMS Manager JSON API v2). Komerční adaptéry jsou napsané podle veřejné dokumentace a pokryté testy s falešným `fetch`; **naživo zatím neověřené** — první obec s danou bránou pošle testovací SMS. Doručenky: polling (cron à 5 min) i webhook (`POST /webhook/sms/<tajemství>`).

## ADR 11 — OTP kódy: HMAC v DB, limity

Šestimístné kódy platí 10 minut, max 3 vydání za hodinu na kontakt, max 5 pokusů na kód; v DB jen HMAC (únik databáze nevydá platné kódy). `OTP_DEV_ZOBRAZIT=1` ukáže kód na stránce — dovoleno jen s `SMS_PROVIDER=konzole` (SMS se reálně neposílají), jinak start selže.

## ADR 12 — Role a oprávnění

Role na účtu: `redaktor` (hlášení, články), `ucetni` (platby), `spravce` (správa účtů, schvalování; zahrnuje práva redaktora), `admin` (vše včetně přidělování rolí; sám sobě role neměnit). Občan = bez role. Role přiděluje jen úřad; do OIDC claims jdou ve scope `obec` (`role`, `cast_obce`, `rezident`), takže je vidí i externí aplikace.

## ADR 13 — Hesla scrypt

`crypto.scrypt` z Node (N=2^15, r=8, p=1) — bez nativních závislostí (argon2 by vyžadoval kompilaci v obrazu). Heslo je vždy volitelné; vyžaduje vyplněný e-mail.

## ADR 14 — Citlivé změny účtu jen po čerstvém ověření (etapa 1, nález bezpečnostního testera)

**Kontext.** V `/ucet` šlo nastavit e-mail i heslo bez ověření. Kdo se na chvíli dostal k přihlášené relaci (cizí počítač, odemčený telefon), nastavil si vlastní e-mail + heslo a měl trvalý přístup.

**Rozhodnutí.** Změna e-mailu a hesla vyžaduje **čerstvé ověření** platné 10 minut v sezení: má-li účet heslo, staré heslo; vždy je k dispozici i nový SMS kód na telefon účtu (OTP účel `zmena`) — kdo heslo zapomněl, ověří se telefonem, který je stejně kotvou účtu. Nový e-mail je jen **čekající** (`email_cekajici`) a platí (i pro přihlášení heslem) až po kódu poslaném na něj (OTP účel `email`). Odebrání e-mailu zruší i heslo. Po změně jde SMS „pokud jste to nebyl(a) vy…“ a **odhlásí se všechna ostatní sezení** i OIDC granty (externí aplikace se přihlásí znovu). Telefon dál mění jen úřad. Přihlášení telefonem + kódem se nemění.

**Důsledky.** Profilový formulář už e-mail nepřijímá. Audit `ucet.overeni`, `ucet.overeni_selhalo`, `ucet.email_zadost`, `ucet.email_zmenen`, `ucet.heslo`, `ucet.odhlaseni_ostatnich`. Limity podle IP (heslo, odeslání a ověření kódu).

## ADR 15 — Soubory: typ podle obsahu, přeuložené obrázky, vlastní úložiště na disku

**Rozhodnutí.** Nahrané soubory se ukládají do `DATA_DIR/soubory/<2 znaky>/<uuid>` (pojmenovaný volume), metadata v tabulce `soubory`. Typ se zjišťuje z obsahu (`file-type`, magic bytes), ne z přípony; povolené jsou PDF, Word/Excel/PowerPoint (OOXML i staré OLE), OpenDocument, RTF a obrázky. Obrázky se **vždy přeuloží** přes `sharp` (otočení podle EXIF, zmenšení na 1920 px, zahození metadat včetně GPS, náhled WebP 640 px). **SVG se nikdy neservíruje** — loga v SVG se rasterizují na PNG (žádný skript v obrázku). Výdej `/soubory/<id>/<název>` s `nosniff`, `Content-Disposition` (PDF inline, ostatní ke stažení, české jméno přes `filename*`), u ne-PDF dokumentů `CSP: sandbox`. Multipart se streamuje na disk (fotky z galerie se do paměti nevejdou); pole formuláře jsou k dispozici před CSRF kontrolou.

## ADR 16 — HTML z editoru jen jako struktura, sanitizace whitelistem na serveru

**Rozhodnutí.** Editor **Quill 2** (vendorovaný z npm, servírovaný z `/static/vendor/quill/`) s povolenými formáty jen pro strukturu: nadpisy H2–H3, tučné, kurzíva, odkazy, seznamy, citace, obrázky, tabulky. Žádné barvy, velikosti ani styly — laik nemůže rozbít vzhled ani přístupnost. Server HTML vždy sanitizuje (`sanitize-html`, whitelist tagů a atributů, `h1` → `h2`). Obrázek vložený editorem jde přes server (žádné base64 v textu) a vyžaduje popis (dialog); zveřejnění s obrázkem bez `alt` server odmítne. Bez JavaScriptu zůstává obyčejné textové pole (HTML se stejně sanitizuje).

**Proč ne Tiptap.** Potřeboval by bundler (desítky ES modulů); Quill 2 je jeden soubor, MIT, stabilní a umí tabulky.

## ADR 17 — Obecní web jako modul platformy (úzký redakční systém), ne WordPress ani Drupal

**Kontext.** Obecní weby jsou z ~85 % proprietární SaaS čtyř dodavatelů (průzkum 10/2026). WordPress/Drupal by znamenaly druhý systém k údržbě (PHP, pluginy, aktualizace) a vlastní přihlašování mimo OIDC.

**Rozhodnutí.** Modul `web`: jedna tabulka `web_obsah` pro stránky, aktuality, akce a odkazy v menu (sdílí editor, koncepty, revize, koš, hledání), k tomu galerie, dokumenty, dotace, přesměrování. Hlavním kritériem je **použitelnost pro laika na úřadě**: velká tlačítka, české popisky bez žargonu, nápověda u polí, náhled před zveřejněním, „Uložit rozpracované“ vs. „Zveřejnit“, automatické ukládání, historie verzí s obnovou, smazání = koš, hlášky s odkazem („Hotovo, aktualita je na webu. Zobrazit →“). Úprava zveřejněného obsahu se ukládá jako **rozpracovaná** (sloupec `koncept`) a web se nezmění, dokud redaktor nezveřejní. Menu má max. 2 úrovně; pořadí se mění šipkami (funguje bez JS). Stránky webu se hledají až ve 404 handleru (`app.zachytavace404`), takže nekolidují s routami modulů.

**Důsledky.** Jedna instalace = jedna obec (multi-tenant ne), ale nic není zadrátované na Vlastibořice: vzhled (barva, znak, úvodní fotka, motto) je v `obec.yml` a v administraci. Barva se automaticky ztmaví, pokud by bílý text neměl kontrast 4,5 : 1.

## ADR 18 — Dotace: povinná publicita jako samostatný obsah s dobou zobrazení

**Rozhodnutí.** Dotace = projekt, poskytovatel, text, odkaz, loga a **zobrazit od–do** (konec doby udržitelnosti). Po skončení se sama skryje; 30 dní předem dostanou správci e-mail (cron 8:00). Pás log na titulce (a volitelně v patičce všech stránek) je mřížka karet se sjednocenou výškou a šedým podkladem (`object-fit: contain`, `mix-blend-mode: multiply` — bílé pozadí JPG splyne), takže vypadá úhledně i s 10 různými logy. Vkládání je průvodce ve 3 krocích s náhledem pásu.

## ADR 19 — Úřední deska: lhůty z kategorií, sejmutí podle data, rozpočet nahrazuje starší

**Rozhodnutí.** Dokument má `vyveseno_od` a `sejmuto_do` (poslední den na desce; `NULL` = do odvolání). „Vyvěšeno / sejmuto“ se počítá dotazem podle času — žádný cron, nic se nemaže; sejmuté jsou ve veřejném archivu. Kategorie nesou zákonné minimum dní (vyhlášky, záměry, veřejné vyhlášky 15) a výchozí lhůtu; kratší vyvěšení formulář odmítne, předčasné sejmutí jen správce s důvodem. Rozpočtová dokumentace (zák. 250/2000 Sb.) má druh a rok; nový dokument k datu svého vyvěšení sám sejme ty, které nahrazuje (návrh → schválený, starší rozpočet/výhled/závěrečný účet). Dny se počítají kalendářně v čase Europe/Prague. Povinně zveřejňované informace mají strukturu vyhlášky 515/2020 Sb. v kódu; obsah bodů se plní z `obec.yml`, výchozích textů nebo textu úřadu, chybějící body jsou ve správě zvýrazněné.

## ADR 20 — Import ze starých webů: adaptér čte, importér ukládá

**Rozhodnutí.** Rozhraní `ImportniZdroj` (stránky, aktuality, deska, menu, dotace, přesměrování) — adaptér jen čte zdroj a vrací neutrální data; společný `Importer` stahuje a přeukládá média, přepisuje odkazy, zahazuje cizí zdroje, staví menu (položka s podnabídkou → rozcestník), dopočítává lhůty desky a zakládá přesměrování 301 (`web_presmerovani`, počítadlo použití). Stahování jen přes `Stahovac` (2 požadavky/s, identifikující User-Agent, limit velikosti). Hotové adaptéry: WordPress (REST API, pilot Vlastibořice), Galileo (HTML). Viz `docs/IMPORT.md`.

## ADR 21 — Vzhled webu: barevná schémata v OKLCH s ověřeným kontrastem

**Kontext.** Web obce má působit hezky (fotka obce, sklo, barevné menu) a zároveň splnit WCAG 2.1 AA i přes libovolnou fotku na pozadí; obec si má vzhled vybrat sama, bez CSS.

**Rozhodnutí.** Schéma = sada barev v **OKLCH** (`src/moduly/web/schemata.ts`): primární, světlá primární „na tmavé“, akcent, aktivní položka, tmavá, světlá. Generují se CSS proměnné s **hex zálohou** a OKLCH v `@supports (color: oklch(0 0 0))` (průhledné odvozeniny přes `color-mix(in oklch …)`). Test `test/schemata.test.ts` počítá kontrast všech dvojic, které se na webu potkávají (tlačítka, odkazy na bílé kartě, štítky, text na akcentu, aktivní menu, patička) — **včetně nejhoršího případu: čistě bílá fotka pod gradientem** (gradient 72 % → 90 % tmavé barvy schématu, sklo 45 %) — a hlídá, že barvy jsou v gamutu sRGB (jinak by je prohlížeče různě ořezávaly). Vlastní barva z `obec.yml` zůstává (ztmavení na 4,5 : 1).

**Důsledky.** Nové schéma se přidá jedním objektem a testem. axe-core v Chromiu ověřuje výsledek na skutečných stránkách se všemi schématy.

## ADR 22 — Písma self-hosted z @fontsource, velikost písma pro návštěvníka

**Rozhodnutí.** 8 dvojic písem (tělo + nadpisy, případně ozdobný titulek) z balíčků @fontsource; platforma vydává jen `woff2` latin + latin-ext z `/static/fonty/` (whitelist cest) a generuje si `@font-face` sama. Čeština ověřena na glyfech (fontkit). Úzká písma (Genos) mají koeficient základní velikosti. Velikost písma: výchozí ze správy, návštěvník si ji přepne tlačítky A / A+ / A++ (GET formulář → cookie `mo_velikost` na rok → server rovnou vykreslí třídu na `<html>`; bez probliknutí, bez JS).

## ADR 23 — Fixní fotografické pozadí, sklo a pohyb jen jako vylepšení

**Rozhodnutí.** Pozadí jsou dvě vrstvy `position: fixed` (ne `background-attachment: fixed`, které iOS nepodporuje) s gradientem přes `::after`. Server vybere první fotku (pevnou nebo náhodnou), takže bez JS je pozadí vidět; v režimu „střídání“ `public/js/web.js` po 25 s přednačte další fotku a vrstvy prolne (nestřídá na skryté záložce). Sklo (`backdrop-filter`) jen v `@supports`, jinak hustší neprůhledné pozadí (slabé telefony, starší prohlížeče). Shimmer menu, vstupní animace, prolínání a počítadla statistik se při `prefers-reduced-motion` vypínají. Náhled vzhledu je uložený v sezení správce (vidí ho jen on, s pruhem Použít / Ukončit); předchozí vzhled se pamatuje pro „Vrátit zpět“. Ikony (favicon, ICO, apple-touch, manifest) se generují ze znaku obce (sharp, průhlednost zachována, centrování do čtverce) a drží v paměti.

---

## Mapa modulů

```
src/
  app.ts                 sestavení Fastify: DB, sezení, CSRF, šablony, moduly
  index.ts               start serveru
  config/  env.ts        .env (zod), obec.ts  obec.yml (zod)
  db/      index.ts, migrate.ts, types.ts, migrations/
  i18n/    cs.ts         všechny texty UI; index.ts  t('klic', {param})
  lib/     kontakty.ts (telefon/e-mail/SMS text), krypto.ts, otp.ts, audit.ts, mail.ts, logger.ts, sms/*
  web/     routes.ts (/, /healthz, povinné stránky), sablony.ts (reply.view), sezeni.ts (Postgres store)
  moduly/
    ucty/      jádro: oidc/provider.ts, oidc/adapter.ts, oidc/klient.ts, interakce.ts (přihlašovací obrazovky),
               routes.ts (/prihlaseni, /ucet, /odhlaseni), sprava.ts (/sprava/*), sluzba.ts, opravneni.ts
    infokanal/ sluzba.ts (odběratelé, výběr příjemců, hlášení), fronta.ts (worker), routes.ts (veřejné),
               sprava.ts (/infokanal/sprava/*), vystrahy/typy.ts (návrh rozhraní)
    deska/     sluzba.ts (vyvěšení, lhůty, rozpočet, archiv), povinne.ts (struktura vyhl. 515/2020),
               routes.ts (/uredni-deska, /rozpocet, /povinne-informace, RSS), sprava.ts (/sprava/deska, /sprava/povinne-informace)
    web/       obsah.ts (stránky/aktuality/akce/odkazy, koncepty, revize, strom menu), dalsi.ts (galerie, dokumenty,
               dotace, přesměrování), vzhled.ts, verejne.ts (titulka, stránky, hledání, 404 → stránka/přesměrování),
               sprava.ts (editor), sprava-dalsi.ts (galerie, dokumenty, dotace, vzhled), udrzba.ts (cron),
               import/ (typy.ts rozhraní, importer.ts, stahovac.ts, wordpress.ts, galileo.ts, html-pomoc.ts)
    kviz/      vyber.ts (algoritmus výběru otázek, bez DB), import.ts (YAML balíky → DB, zod), sluzba.ts (hráči, hra,
               skóre, správa), routes.ts (/kviz/*), sprava.ts (/sprava/kviz)
  lib/     … + soubory.ts (úložiště souborů), html.ts (sanitizace), barvy.ts (kontrast), datum.ts (Praha), hledani.ts, slug.ts
  web/     … + nahravani.ts (multipart na disk), soubory.ts (/soubory/:id)
views/   Eta šablony (layout.eta + složky dle modulů)     public/  CSS, favicon, robots
test/    Vitest (jednotkové + HTTP proti Postgresu)        src/scripts/seed.ts (demo data)
```

Plánované moduly (etapa 1+): `rezervace` (+ platby, vyúčtování), `knihovna`, `vystrahy` (ČHMÚ, ČEZ, voda) — viz `docs/MODULY.md`.

## Datový model jádra

```
uzivatele      id uuid PK · telefon UNIQUE (E.164, kotva účtu) · email (unikátní bez ohledu na velikost písmen)
               heslo_hash · jmeno · prijmeni · prezdivka · cast_obce · role text[] · rezident
               gdpr_souhlas_at · telefon_overen_at · email_overen_at · blokovan_at · vytvoren_at · upraven_at
otp_kody       kontakt · ucel (prihlaseni|odber|registrace) · kod_hash (HMAC) · expires_at · pouzit_at · pokusy
audit_log      ts · uzivatel_id · akce · detail jsonb · ip           (nikdy se nemaže)
sezeni         sid PK · data jsonb · expires_at                      (@fastify/session)
oidc_payloads  (typ, id) PK · payload jsonb · grant_id · user_code · uid · expires_at · consumed_at
               — všechny modely oidc-provider (Session, Interaction, AuthorizationCode, AccessToken, RefreshToken, Grant…)
oidc_klienti   client_id PK · client_secret · nazev · redirect_uris[] · post_logout_redirect_uris[] · duveryhodny · aktivni
nastaveni      klic PK · hodnota jsonb                               (např. oidc_jwks — podpisové klíče ES256 + RS256)

infokanál:
ik_kategorie   slug · nazev · povinna · poradi
ik_odberatele  id uuid · jmeno · telefon UNIQUE · email · cast_obce · kanal (sms|email|smisene) · token (odhlašovací odkaz)
               overen_at · odhlasen_at · zdroj (web|sms|urad|import|ucet) · souhlas_at · uzivatel_id → uzivatele
ik_optouty     (odberatel_id, kategorie_id)
ik_hlaseni     autor_id · kategorie_id · krizove · cil (vse|casti) · cil_detail jsonb · sms_text · email_predmet · email_text
               email_html · clanek_titulek · clanek_html · stav (naplanovano|odesila_se|hotovo|zruseno) · naplanovano_na · zdroj_automatu
ik_prijemci    hlaseni_id · odberatel_id · kanal · kontakt · stav (ceka|odeslano|doruceno|selhalo|vzdano) · brana_id · pokusy · posledni_chyba

úřední deska a web (etapa 1):
soubory        id uuid · druh (dokument|obrazek|logo) · puvodni_nazev · mime (z obsahu) · pripona · velikost · sirka · vyska · alt · sha256 · zdroj_url
ud_kategorie   slug · nazev · min_dni · vychozi_dni · rozpocet · poradi · aktivni
ud_dokumenty   nazev · kategorie_id · cislo_jednaci · puvodce · popis · vyveseno_od · sejmuto_do (NULL = do odvolání) · sejmuti_duvod
               typ_rozpoctu · rok · hlaseni_id · autor_id · puvodni_url · smazano_at (koš)
ud_prilohy     (dokument_id, soubor_id) · poradi             pi_body  klic (bod vyhl. 515/2020) · obsah_html
web_obsah      typ (stranka|aktualita|akce|odkaz) · titulek · slug · nadrazena_id · poradi · v_menu · odkaz_url · perex · obsah_html
               obrazek_id · kategorie_id · datum · akce_konec · akce_misto · stav (koncept|zverejneno) · koncept jsonb · zdroj · puvodni_url · smazano_at
web_revize     obsah_id · data jsonb · duvod (zverejneni|koncept)       web_kategorie  slug · nazev
web_galerie    nazev · slug · datum · stav  + web_galerie_fotky (galerie_id, soubor_id, poradi, popisek)
web_dokumenty  nazev · popis · skupina · soubor_id
web_dotace     projekt · poskytovatel · text · odkaz · zobrazit_od · zobrazit_do · v_paticce · stav · upozorneno_at  + web_dotace_loga
web_presmerovani  stara_cesta PK · nova_cesta · pocet · posledni_at
```

Vazba občan ↔ odběratel: podle telefonu (`ik_odberatele.uzivatel_id` se doplní, když se občan přihlásí k odběru z účtu). Účet není podmínkou odběru — senior bez účtu se přihlásí jen telefonem a kódem.

## Tok přihlášení (sekvence)

1. `GET /prihlaseni` → vytvoří PKCE verifier/state/nonce do sezení → 302 `/oidc/auth?...client_id=platforma`
2. provider nemá sezení → 303 `/oidc/interaction/<uid>` → formulář telefon
3. `POST …/telefon` → OTP (SMS přes `SmsPoskytovatel`) → formulář kód
4. `POST …/kod` → účet najdi/založ → bez GDPR souhlasu stránka souhlasu → `interactionFinished({login})`
5. provider: důvěryhodný klient → grant automaticky (`loadExistingGrant`); cizí → obrazovka souhlasu (`POST …/pristup`)
6. 303 `/prihlaseni/callback?code=…` → `openid-client` vymění kód (token endpoint přes `INTERNAL_BASE_URL`) → ověří ID token (ES256, JWKS) → aplikační sezení (`uzivatelId`, `idToken`)
7. odhlášení: `POST /odhlaseni` → smaže sezení → 302 `/oidc/session/end?id_token_hint=…` → potvrzení (auto-submit) → `post_logout_redirect_uri`
