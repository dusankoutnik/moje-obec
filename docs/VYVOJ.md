# Vývoj

## Prostředí

Vývoj i běh jsou v Dockeru s Node 22 — na počítači Node být nemusí (na serveru Vlastibořic je jen Node 18).

```bash
cp .env.example .env && cp obec.example.yml obec.yml     # doplnit tajemství (openssl rand -hex 32)
docker compose -f docker-compose.dev.yml up               # Postgres (localhost:5432) + aplikace (tsx watch) na :3000
```

Alternativa bez compose: `./dev.sh <příkaz>` spustí cokoliv v kontejneru `node:22-bookworm-slim` s projektem namountovaným pod vaším uid (soubory nevznikají jako root). Proměnné `DEV_NET` (docker síť) a `DATABASE_URL`/`TEST_DATABASE_URL` se předávají dovnitř.

```bash
./dev.sh npm install
./dev.sh npm run typecheck
./dev.sh npm run lint          # eslint + prettier --check
./dev.sh npm run format        # prettier --write
DEV_NET=platforma_test TEST_DATABASE_URL=postgres://platforma:platforma@platforma_test_db:5432/platforma_test ./dev.sh npm test
./dev.sh npm run build         # tsc → dist/
```

Testovací Postgres pro `./dev.sh npm test` bez compose (jednorázově):

```bash
docker network create platforma_test
docker run -d --name platforma_test_db --network platforma_test --memory 256m \
  -e POSTGRES_USER=platforma -e POSTGRES_PASSWORD=platforma -e POSTGRES_DB=platforma_test postgres:16-alpine -c shared_buffers=32MB
```

Ve vývoji: `SMS_PROVIDER=konzole` (SMS jen do logu) a `OTP_DEV_ZOBRAZIT=1` (kód se ukáže na stránce). Demo data: `./dev.sh npx tsx src/scripts/seed.ts [+420telefon]` → admin účet + 4 odběratelé.

## Struktura kódu

Viz mapa v `docs/ARCHITEKTURA.md`. Zásady:

- **Modul** = složka `src/moduly/<nazev>/` s `index.ts` (Fastify plugin zabalený do `fastify-plugin`, aby dekorátory byly vidět všude), `sluzba.ts` (doménová logika bez HTTP), `routes.ts` (veřejné), `sprava.ts` (úřad), migrace v `src/db/migrations/NNNN_<nazev>.ts`, šablony ve `views/<nazev>/`, texty v `src/i18n/cs.ts` pod klíčem modulu. Zapnutí v `obec.yml` → `moduly.<nazev>: true` a registrace v `src/app.ts`.
- **Texty jen přes `t('sekce.klic', {param})`** — žádné české řetězce v šablonách ani kódu (výjimka: komentáře a logy).
- **Šablony** Eta: **pozor na začátek bloku kódu:** řádek `<% [a, b].forEach(…) %>` nebo `<% (x || '').split(…) %>` se v Eta připojí k předchozímu výrazu (chybí středník → `'…'[…]` / `'…'(…)` a chyba 500). Pište `<% ;[ … %>`. Hlídá to test v `test/schemata.test.ts`.
- **Šablony** Eta: **pozor — výraz v `<%= %>` se escapuje celý, takže atribut poskládaný jako řetězec (`<%= x ? 'aria-current="page"' : '' %>`) se rozbije na `aria-current=&quot;page&quot;`.** Pište `<% if (x) { %>aria-current="page"<% } %>` nebo hodnotu bez uvozovek (`'aria-current=page'`). Test `web.test.ts` to hlídá.
- **Šablony** Eta: `<% layout('/layout') %>` na začátku (cesta od kořene `views/`), data pod `it.`; `<%= %>` escapuje, `<%~ %>` ne (jen pro důvěryhodné HTML). Každý formulář má `<input type="hidden" name="_csrf" value="<%= it.csrf %>">`.
- **Ochrana rout:** `preHandler: vyzadujPrihlaseni` nebo `vyzadujRoli('spravce')` z `src/moduly/ucty/opravneni.ts`.
- **DB:** Kysely, typy v `src/db/types.ts` ručně vedle migrací. Časové sloupce s `DEFAULT now()` mají typ `TimestampGenerated` (Kysely nerozbalí `Generated<ColumnType>`). JSON sloupce `JSONColumnType` — při insertu `JSON.stringify`.
- **Audit:** každá změna úřadem i důležitá akce občana → `zapisAudit(db, { uzivatelId, akce: 'modul.akce', detail, ip })`.
- **Logování:** `app.log` / `req.log` (pino), objekty před zprávou: `log.warn({ err, id }, 'co se stalo')`.

## Testy

Vitest; `test/pomocnici.ts` postaví aplikaci na volném portu s čistou testovací DB (`DROP SCHEMA public CASCADE` + migrace), konzolovými SMS/e-maily (`t.sms.odeslane`, `t.mail.odeslane`) a bez plánovače (rozesílku spouští test přes `t.app.infokanalFronta.zpracujVse()`). `Prohlizec` je mini prohlížeč (cookie jar, přesměrování) nad `fetch`. Soubory testů běží sériově (sdílená DB).

- jednotkové: `kontakty`, `vyber-prijemcu`, `sms-adaptery` (falešný `fetch`), `otp` (s DB)
- HTTP: `ucty` (přihlášení, heslo, role, blokace, audit), `zmeny-uctu` (čerstvé ověření před změnou e-mailu/hesla), `deska` (lhůty, přílohy, EXIF, archiv, RSS, rozpočet, povinné informace), `web` (stránky, koncepty, revize, editor, galerie, dotace, přesměrování, hledání, vzhled, přístupnost), `import` (WordPress/Galileo s falešným stahováním), `oidc` (externí klient: discovery, PKCE, kód → tokeny, ID token proti JWKS, userinfo, refresh, souhlas/odmítnutí), `infokanal` (odběr s OTP, správa, odhlášení odkazem, hlášení → fronta → preference kanálů, krizové, zastavení, webhook)

Nový test potřebuje jen `spustTestApp()` v `beforeAll` a `zavri()` v `afterAll`.

### Pokrytí kódu testy

`npm run test:pokryti` (= `vitest run --coverage`, provider v8) vypíše souhrn a uloží HTML zprávu do `coverage/`
(mimo git). Prahy jsou ve `vitest.config.ts` (`coverage.thresholds`) a CI pod nimi spadne. Nastavené jsou
o 3–4 body pod naměřeným stavem, aby nepadaly náhodně (měření 19. 10. 2026: řádky 87,9 %, příkazy 84,0 %,
funkce 85,7 %, větve 72,3 % → prahy 84 / 80 / 82 / 68).

Jak práh zvedat: po větší dávce testů pusťte `npm run test:pokryti`, podívejte se na souhrn (v CI je i v souhrnu
běhu) a prahy posuňte zase na „naměřeno minus 3–4 body“, zaokrouhleno dolů. Práh nikdy nesnižujte kvůli
novému kódu bez testů — dopište testy. Soubory, které testovat nejde (CLI skripty, start serveru), jsou
vyjmuté v `coverage.exclude`.

### Audit závislostí

CI pouští `npm audit --audit-level=high`: zranitelnost úrovně high nebo critical shodí build. Oprava = aktualizace
závislosti (`npm install balicek@verze`, u major verze projít changelog a pustit testy). Když oprava neexistuje
a zranitelnost se nás netýká, zapište to sem i s odkazem na advisory. Aktuálně zůstává jen nízká (low)
zranitelnost Quillu (GHSA-v3m3-f69x-jf25, XSS v exportu HTML) — výstup editoru se na serveru vždy sanitizuje.

> **npm 10 a „Cannot read properties of null (reading 'edgesOut')“** při instalaci nové verze Vitestu: chyba
> npm při řešení peer závislostí. Pomůže `npx -y npm@11 install …`; vzniklý `package-lock.json` funguje
> s `npm ci` i v npm 10 (CI).

### Smoke test v prohlížeči (Playwright)

`e2e/smoke.spec.ts`: redaktor webu se přihlásí SMS kódem (vývojový režim ukazuje kód na stránce), napíše
aktualitu, počká na automatické uložení konceptu, zveřejní ji a ověří ji na titulce. Konfigurace
`playwright.config.ts` sama spustí aplikaci (`tsx src/index.ts`, port 3100, místní `.env` se nenačítá) proti
databázi z `E2E_DATABASE_URL` — **musí to být samostatná databáze s názvem končícím na `_e2e` nebo `_test`**
(test do ní zakládá účet). V CI běží jako samostatný job jen na push do `main`.

Lokálně (prohlížeč z oficiálního obrazu, verze musí sedět s `@playwright/test` v `package.json`):

```bash
docker network create pt_e2e
docker run -d --name pt_e2e_db --network pt_e2e -e POSTGRES_USER=platforma -e POSTGRES_PASSWORD=platforma \
  -e POSTGRES_DB=platforma_e2e postgres:16-alpine
docker run --rm --network pt_e2e -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_DATABASE_URL=postgres://platforma:platforma@pt_e2e_db:5432/platforma_e2e \
  mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test
docker rm -f pt_e2e_db && docker network rm pt_e2e
```

Při chybě je v `test-results/` záznam (trace) — `npx playwright show-trace <soubor>.zip`.

## Kontrola v prohlížeči a přístupnost (axe-core)

Testy kontrolují přístupnost jen staticky (alt u obrázků, popisky polí, neescapované atributy). Skutečné vykreslení,
kontrasty a pravidla WCAG 2.1 A/AA ověřuje `scripts/kontrola-prohlizecem.mjs`: headless Chromium (`zenika/alpine-chrome`)
ovládané přes DevTools protokol (bez Playwrightu), screenshoty na desktopu i mobilu a audit `axe-core`, včetně
přihlášení do administrace (vývojová instalace ukazuje SMS kód na stránce).

```bash
docker run -d --rm --name kontrola-chrome --network web --memory 512m zenika/alpine-chrome \
  --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 --remote-allow-origins=* about:blank
mkdir -p /tmp/kontrola && chmod 777 /tmp/kontrola
docker run --rm --network web -v $PWD:/app -v /tmp/kontrola:/out -w /app node:22-bookworm-slim \
  node scripts/kontrola-prohlizecem.mjs http://platforma:3000 /out 777000001
docker stop kontrola-chrome
```

Výsledek: `*.png` a `axe.json` (porušení podle pravidel). Stránky lze vybrat proměnnými `STRANKY` a `ADMIN`. `SCHEMATA=vlastiborice:ubuntu,outdoor:outdoor,…` projde barevná schémata (a písma) přes náhled vzhledu a ověří stránky `STRANKY_SCHEMATA`. U dev instalace za HTTP heslem: veřejná adresa + `AUTH=uzivatel:heslo`.

## Import ze starých webů

Viz [IMPORT.md](IMPORT.md) — rozhraní adaptéru, společný importér, CLI `src/scripts/import.ts`.

## Jak přidat SMS bránu

1. `src/lib/sms/<nazev>.ts` — třída implementující `SmsPoskytovatel` (`posli`, `stavDoruceni`, volitelně `zpracujWebhook`); konstruktor bere konfiguraci a volitelný `fetch` (kvůli testům). Chyby vyhazovat jako `SmsChyba(message, docasna)` — `docasna=true` znamená „zkus znovu“ (fronta má 3 pokusy).
2. `src/config/env.ts` — proměnné; `src/lib/sms/index.ts` — větev ve `vytvorSmsPoskytovatele`.
3. test v `test/sms-adaptery.test.ts` s falešným `fetch`.
4. záznam do tabulky v `docs/MODULY.md`.

## OIDC klient pro externí aplikaci

```sql
INSERT INTO oidc_klienti (client_id, client_secret, nazev, redirect_uris, post_logout_redirect_uris)
VALUES ('moje-apka', '<openssl rand -hex 24>', 'Moje aplikace', '{https://apka.example.cz/callback}', '{https://apka.example.cz/}');
```

Discovery: `https://<doména>/oidc/.well-known/openid-configuration`. Authorization Code + PKCE (S256) je povinné, `client_secret_basic`, ID token ES256. Scopes: `openid profile email phone obec offline_access`; scope `obec` dává claims `cast_obce`, `rezident`, `role`. Cizí klient dostane obrazovku souhlasu; `duveryhodny=true` ji vynechá (jen pro vlastní moduly).

## Styl a kvalita

Prettier (jednoduché uvozovky, 110 znaků), ESLint (typescript-eslint recommended, `consistent-type-imports`), `strict` TypeScript s `noUncheckedIndexedAccess`. Commit zprávy česky, v rozkazovacím způsobu nebo popisně, s řádkem `Co-Authored-By` u strojově psaného kódu. CI (`.github/workflows/ci.yml`) pustí lint, typy, testy proti Postgresu a build obrazu.
