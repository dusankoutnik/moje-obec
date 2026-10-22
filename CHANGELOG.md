# Změny

Formát: [Keep a Changelog](https://keepachangelog.com/cs/), verze podle [SemVer](https://semver.org/lang/cs/).

## [Nevydáno] — 2026-10-18 — etapa 1: úřední deska, obecní web, import

### Přidáno (stránka Můj účet, 22. 10. 2026)

- `/ucet` = jediná stránka všech nastavení účtu (náhrada aplikace MůjÚčet), karty podle zapnutých modulů
  (`app.moduly.stav()`): osobní údaje, telefon, e-mail/heslo, odběr hlášení (kanál SMS / SMS i e-mail, kategorie,
  přihlášení jedním klikem `POST /ucet/odber`), rezervace (souhrn z `GET /api/sso/summary/:cislo`), posilovna
  a přístupy, eKlíč (`POST /ucet/eklic` → `POST /api/sso/ekey/:cislo`; nabídka použít e-mail TTLock pro zprávy obce
  jen se souhlasem `POST /ucet/eklic-email`, odmítnutí v `navic.ekey_email_odmitnut`), spolujízda, eKnihy
  (`POST /ucet/eknihy` → `navic.eknihy_sms`), soukromí (`GET /ucet/moje-udaje.json`, `POST /ucet/vymaz` = žádost
  úřadu e-mailem). Aplikace neodpoví → karta „teď nedostupné“.
- `/ucet/platby` (aktuální měsíc, výzvy k úhradě s PDF a QR platbou, předprodej) z `GET /api/sso/platby/:cislo`.
- Změna telefonu se schválením úřadem: `GET/POST /ucet/telefon` (po čerstvém ověření), migrace 0021
  `uzivatele_zmeny_telefonu`, avízo správcům e-mailem, Správa `/sprava/ucty/zmeny-telefonu` (správce) — schválení
  přepíše telefon účtu i odběratele, SMS na nové / při zamítnutí na staré číslo přes frontu infokanálu.
- Aplikace rezervací se volá napřímo `APLIKACE_REZERVACE_URL` s `x-api-secret: INTERNI_API_SECRET`.

### Přidáno (moduly obce a aplikace za proxy, 22. 10. 2026)

- Moduly obce zapínatelné ve Správě → Moduly obce (`/sprava/moduly`, admin, audit `moduly.zmena`): rezervace,
  předprodej, spolujízda, eKnihy, infokanál, kvíz; `nastaveni.moduly`, výchozí z `obec.yml` (nové klíče
  `predprodej`, `spolujizda`, `eknihy`); služba `app.moduly` s keší. Vypnutý modul zmizí z menu, úvodu, patičky
  a mapy stránek, jeho stránky vrací 404 „Tato služba není v obci zapnutá“ (správa zůstává).
- Veřejné `GET /api/moduly` pro horní lištu aplikací.
- Proxy `/rezervace/*` a `/eknihy/*` na aplikace obce (`APLIKACE_REZERVACE_URL`, `APLIKACE_EKNIHY_URL`,
  `APLIKACE_TIMEOUT_MS`): mimo sezení/CSRF/CSP platformy, tělo 1:1, `X-Forwarded-*`, 502 při nedostupnosti.
- `docker-compose.prod-server.yml` (instance `platforma_prod` vedle devu).
### Přidáno (účty z MůjÚčtu, 22. 10. 2026)

- Migrace 0017: `uzivatele.cislo` (číslo účtu = id v MůjÚčtu, sekvence pro nové), `rezident_posouzen_at/_by`,
  `navic jsonb`; `oidc_klienti.auth_metoda`.
- Claim `mujucet_id` ve scope `obec`; OIDC klienti `rezervace` a `eknihy` z env (`OIDC_REZERVACE_SECRET`,
  `OIDC_EKNIHY_SECRET`, `OIDC_KLIENTI`), první strana bez souhlasu.
- end_session (odhlášení z aplikace) ukončí i sezení platformy.
- Interní API `/api/interni/uzivatel/:cislo`, `/api/interni/uzivatele?role=`, `POST …/rezident` (`INTERNI_API_SECRET`).
- Převodní skript `src/scripts/prevod-mujucet.ts` (`--nanecisto`, `--anonymizovat`, `--sloucit-telefonem`,
  `--redaktor-bez-webu`); hesla MůjÚčtu (scrypt N=16384) se ověří nativně a po přihlášení přepočítají. Návod `docs/PREVOD.md`.
### Přidáno (infokanál — přechod z VlastiKanálu)

- Převod VlastiKanálu `src/scripts/prevod-vlastikanal.ts` (odběratelé, kategorie, opt-outy, historie hlášení se
  souhrnem; `--nanecisto`, `--anonymizovat`, `--doparovat`), migrace 0018 (`prevod_id`, `mujucet_cislo`,
  `ik_hlaseni.souhrn`, odchozí fronta `ik_odchozi`), `docs/PREVOD.md`.
- Interní API `POST /api/interni/odeslat` (fronta s opakováním, předpona obce, limit délky, audit) a
  `GET /api/interni/odber`; sdílené ověření `src/lib/interni-api.ts` (`INTERNI_API_SECRET`).
- Příchozí SMS: `START jméno`, `STOP`, `ODVOZ cíl` (předání rezervacím), ostatní e-mailem správcům.
- SMSGate: webhooky příchozích SMS a doručenek, podpis `X-Signature`, skript `smsgate-webhook.ts`;
  hlídání brány (offline telefon, nedostupný cloud) s e-maily `BRANA_NOTIFY`.
- Env `INTERNI_API_SECRET`, `APLIKACE_REZERVACE_URL`, `SPOLUJIZDA_HOOK_URL`, `SPOLUJIZDA_HOOK_SECRET`,
  `INFOKANAL_NOTIFY`, `BRANA_NOTIFY`, `BRANA_LIMIT_MIN`, `SMSGATE_WEBHOOK_KLIC`.
### Přidáno (API pro integrace)

- REST API `/api/v1` (migrace 0020): tokeny integrací s rozsahy (`api_tokeny`, Správa → API a integrace, audit,
  limit na token), příspěvky (`POST`/`PATCH`/`GET`, idempotence `zdroj` + `externi_id`, markdown, obrázek, přílohy),
  `POST /soubory`, `POST /deska` (zákonné lhůty, potvrzení nahrazení), `POST /prispevky/:id/rozeslat`,
  `POST /zpravodaj` (`web_zpravodaj`, počet obyvatel v úvodu z posledního čísla, akce jako koncepty).
- Dokumentace `/api` a OpenAPI 3.1 `/api/openapi.json`; odkaz „API“ v patičce.
- Rozesílka příspěvku infokanálem vyčleněna do `infokanal/z-prispevku.ts` (správa i API).
### Přidáno (automatické výstrahy infokanálu)

- Výstrahy ČHMÚ (CAP, ORP z `obec.yml`): žlutá ke schválení správci (e-mail s odkazem, Rozeslat / Zahodit), oranžová
  se rozešle sama (v noci 22–6 h naplánovaně na 6:30), červená jako krizové hlášení; pokračování a nižší stupeň
  během vyššího podle VlastiKanálu.
- Odstávky elektřiny ČEZ z dat modulu odstavky: oznámení, připomínka den předem v 17:00, změna termínu, zrušení;
  cílení na dotčené části obce + odběratele bez vyplněné části.
- Výpadky vody SčVK (plánované odstávky a havárie z HTML seznamů): oznámení s plným textem a seznamem odběrných míst,
  připomínka, změna, zrušení/ukončení (zmizení ze seznamu + 404 detailu).
- Migrace 0019 (`ik_vystrahy`, `ik_vystrahy_zdroje`), `obec.yml` → `vystrahy`, env `VYSTRAHY`, `VYSTRAHY_NOTIFY`;
  veřejná stránka `/infokanal/vystrahy`, správa `/infokanal/sprava/vystrahy`; e-mail správcům o každém automatickém
  rozeslání a jednou při výpadku zdroje > 24 h.

### Přidáno (text dokumentů a vyhledávání v nich)

- Text nahraných dokumentů pro vyhledávání (migrace 0015, `soubory_text`): textová vrstva PDF (`pdftotext`),
  skeny přes OCR (`pdftoppm` + `tesseract`, ces+eng), docx/xlsx/pptx/odt/ods/odp (ZIP/XML, `fflate`), `.doc`
  (`antiword`), RTF, obrázek nahraný jako dokument. Worker na pozadí (jeden soubor po druhém, `nice`, opakování
  chyb 3×, cron à 1 min), rychlá kontrola vrstvy při nahrání PDF s hláškou správci.
- `/hledat`: zdroj „v dokumentech“ s úryvkem a zvýrazněnými slovy, odkaz na místo na webu (úřední deska,
  `/dokumenty#d-<id>`, stránka s odkazem na soubor); sloučení s ostatními výsledky; neveřejné soubory se nehledají.
- Správa: `/sprava/web/text-dokumentu` (stav fronty, seznamy, „Zpracovat znovu/teď“, hromadné „Zkontrolovat všechny
  dokumenty znovu“ a „Znovu jen chyby a bez textu“ s potvrzením a auditem), štítky stavu u dokumentů desky a souborů
  ke stažení, karta na dashboardu; skript `src/scripts/text-souboru.ts`.
- Env `TEXT_SOUBORU`, `OCR_JAZYKY`, `OCR_MAX_STRAN`, `OCR_DPI`, `TEXT_MAX_ZNAKU`; obraz Dockeru s poppler-utils,
  tesseract-ocr (+ces, +eng), antiword; CI je instaluje před testy.

### Přidáno (akce propojené s rezervacemi)

- Akce webu propojené s termíny rezervačního systému (`web_obsah.rezervace_ref`, migrace 0014): synchronizace
  à 10 min zakládá koncepty akcí (`web.akce_koncepty`), nabízí propojení s podobnou akcí, hlídá změnu termínu
  a zrušení; správa „Akce ke zpracování“ (`/sprava/web/akce/zpracovani`) s počtem na dashboardu.
- Editor akce: propojení s rezervací, pozvánka v Aktualitách (`v_aktualitach`), kategorie.
- Kalendář `/akce` a úvod: propojený termín se zobrazí jako akce webu (bez duplicity), série s nejbližším výskytem.
- `/aktuality`, kategorie a RSS obsahují i pozvánky na akce.
- Rozesílka zveřejněné aktuality nebo akce infokanálem s předvyplněným hlášením a evidencí u příspěvku.
- Statistiky úvodu: každá dlaždice je odkaz (`obec.fakta[].odkaz`), zprávy podle `web.stat_zpravy_kategorie`,
  pět nejbližších akcí.

### Přidáno

- Modul **úřední deska**: dokumenty s přílohami, kategorie se zákonným minimem dní, automatické sejmutí podle data, archiv, RSS, předčasné sejmutí s důvodem, koš; rozpočtová dokumentace s nahrazováním starších dokumentů (`/rozpocet`); povinně zveřejňované informace podle vyhl. 515/2020 Sb. (`/povinne-informace`); „vyvěsit + rozeslat“ přes infokanál.
- Modul **obecní web**: stránky (menu 2 úrovně), aktuality, akce, fotogalerie, dokumenty ke stažení, dotace s pásem log a dobou zobrazení, hledání (fulltext bez diakritiky), vzhled podle obce (barva s hlídáním kontrastu, znak, úvodní fotka), editor Quill 2 (vendorovaný), koncepty, náhled, automatické ukládání, revize, koš, přesměrování starých adres.
- **Import** ze starých webů: rozhraní adaptérů, společný importér, adaptéry WordPress (REST) a Galileo (HTML), CLI `src/scripts/import.ts`.
- Úložiště souborů (kontrola typu podle obsahu, obrázky bez EXIF/GPS, náhledy, SVG loga → PNG), sanitizace HTML, multipart na disk, volume pro data.
- Kontrola v prohlížeči (`scripts/kontrola-prohlizecem.mjs`): screenshoty a audit axe-core.

### Přidáno (dokončení code review)

- Zámek přihlášení heslem po opakovaných chybách (čítač v DB podle e-mailu, exponenciální odklad, zrušení správcem).
- Úřední deska: před nahrazením rozpočtových dokumentů náhled „co se sejme“ s potvrzením.
- Dashboard správy: rozpočet SMS s kódy a stav fronty infokanálu.
- CI: pokrytí testy s prahy, `npm audit --audit-level=high`, Playwright smoke test (`e2e/`).

### Přidáno (elektronická podatelna)

- Modul **podatelna** (`moduly.podatelna`): veřejný formulář `/podatelna` pro podání bez elektronického podpisu (CSRF, limit podle IP, past na roboty, funguje bez JS), uložení s číslem `EP-<rok>-<pořadí>`, e-mail na adresu podatelny s Reply-To na podatele, automatická zpráva o doručení podateli, správa `/sprava/podatelna` pro správce obce (vyřízení, poznámka, audit), doba uchování `podatelna.uchovani_let` (výchozí 5 let, nic se nemaže samo).

### Přidáno (etapa 1c — vzhled)

- 9 barevných schémat v OKLCH s testem kontrastu, 8 dvojic písem (@fontsource, vč. Ubuntu), přepínač velikosti písma pro návštěvníky, fotky pozadí se střídáním, hero se statistikami, plovoucí menu, náhled a vrácení vzhledu ve správě, favicon a ikony ze znaku obce. Seznam licencí: `docs/LICENCE-TRETICH-STRAN.md`.

### Změněno

- Vnitřní rozdělení velkých modulů (import, správa webu, obsah webu) bez změny chování.
- **Bezpečnost účtu:** změna e-mailu a hesla jen po čerstvém ověření (heslo / SMS kód), nový e-mail platí až po potvrzení kódem, po změně upozornění SMS a odhlášení ostatních sezení.
- Titulní stránka je při zapnutém modulu `web` obecní web; rozcestník služeb je na `/sluzby`.
- Statické soubory se odkazují s verzí (`?v=`).

### Opraveno

- Migrace 0008: přečíslování povinných informací je bezpečné zavolat znovu (značka v nastavení).
- Aktualizace závislostí se známými zranitelnostmi: @fastify/static 10, nodemailer 10, vitest 4.
- Podle externího code review (import, obsah webu, soubory): stahovač importu čte tělo proudem s limitem
  (Content-Length i počítadlo, i po rozbalení gzip), má časové limity, sleduje přesměrování ručně a odmítá neveřejné
  adresy po překladu DNS; média jen ze starého webu obce; vadná položka importu už neshodí celý import a článek či
  dokument se ukládá v transakci s přílohami a přesměrováním; menu importu nesahá na ruční odkazy redakce a
  zplošťuje jen importované stránky; `$&` v textu ze zdroje, líně načítané obrázky (`data-src`), relativní adresy
  vůči stránce a kotvy; naplánované aktuality se nenajdou hledáním; obnova revize skrytého obsahu (koncept, adresa,
  rodič); smyčky přesměrování se odmítnou; adresa nezveřejněného konceptu jde s titulkem; náhled nic neukládá;
  uložení obsahu v transakci s opakováním při kolizi adresy; soubor se zapisuje na disk před řádkem v databázi;
  keš aktivních dotací; adresy výsledků hledání a podstránek bez N+1 dotazů; upozornění na konec dotace jen po
  odeslaném e-mailu, cron v časové zóně Europe/Prague; adresa `/velikost` je rezervovaná.
- Atributy poskládané v escapovaném výstupu šablon (`aria-current=&quot;page&quot;`) — aktivní položka menu se neoznačovala.
- Převod času na Europe/Prague ignoroval sekundy.

## [0.1.0] — 2026-10-13 — etapa 0: základy

### Přidáno

- Kostra aplikace: Node 22 + TypeScript, Fastify, PostgreSQL 16 (Kysely, explicitní SQL migrace), šablony Eta, pino, `/healthz`, profil obce `obec.yml`, konfigurace `.env` (zod), texty v jednom slovníku (`src/i18n/cs.ts`).
- Jádro „účty“: přihlášení telefonem a SMS kódem (účet vznikne sám), volitelný e-mail + heslo (scrypt), GDPR souhlas při prvním přihlášení, profil, role (redaktor, účetní, správce, admin) a blokace spravované úřadem, audit log, správa (`/sprava`).
- Vestavěný OpenID Connect provider (`oidc-provider`): discovery, JWKS (ES256 + RS256), Authorization Code + PKCE, refresh, userinfo, introspekce, revokace, RP-initiated logout, obrazovka souhlasu pro cizí klienty; platforma je sama svým prvním klientem (`openid-client`).
- Modul infokanál: odběratelé (telefon/e-mail, část obce, preference kanálu, kategorie s opt-outem), přihlášení k odběru s OTP, správa odběru, odhlášení odkazem, hlášení (SMS + e-mail + článek, krizové, cílení na části, plánování), rozesílací fronta s tempem a pokusy, doručenky (polling + webhook), správa pro redaktory.
- Abstrakce SMS poskytovatele: `konzole`, `smsgate`, `smsbrana` (SMSbrána.cz), `gosms` (GoSMS), `smsmanager` (SMS Manager) — komerční adaptéry podle veřejné dokumentace, zatím bez ověření naživo.
- Návrh rozhraní automatických výstrah (ČHMÚ, ČEZ, voda/SčVK) a průzkum zdrojů (`docs/MODULY.md`).
- Testy (Vitest, 49 testů: jednotkové + HTTP proti Postgresu), ESLint + Prettier, CI (GitHub Actions), Docker multi-stage obraz bez root uživatele, `docker compose` balík (app + Postgres + Caddy), vývojový a dev-server compose.
- Dokumentace: README, ARCHITEKTURA (ADR), MODULY, INSTALACE, VYVOJ, STAV.
