# Změny

Formát: [Keep a Changelog](https://keepachangelog.com/cs/), verze podle [SemVer](https://semver.org/lang/cs/).

## [Nevydáno] — 2026-10-18 — etapa 1: úřední deska, obecní web, import

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
- Veřejné stránky webu mají kanonickou adresu (`<link rel="canonical">` z `BASE_URL`, bez dotazu a koncového
  lomítka) a Open Graph / Twitter card (titulek, popis, úvodní fotka nebo znak obce) — web dostupný na více
  hostech se ve vyhledávačích nezdvojuje a odkaz sdílený na sociálních sítích má náhled. Stránky s `noindex`
  a chybové stránky je nemají.
- Sitemap obsahuje i `/odstavky` (zapnutý modul) a detaily aktivních dotací `/dotace/<id>`.

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
