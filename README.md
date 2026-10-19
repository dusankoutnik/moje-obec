# Moje obec 2.0

Otevřená platforma pro **malé české obce**: obecní web s jednoduchým redakčním systémem pro úřad, úřední deska s povinně zveřejňovanými informacemi, jeden účet občana (přihlášení telefonem a SMS kódem, standardní OpenID Connect), infokanál (hlášení obce SMSkou a e-mailem) a postupně další služby — rezervace obecních prostor s vyúčtováním, obecní knihovna.

Vzniká na základě tří měsíců provozu obdobných aplikací v obci Vlastibořice (290 účtů, 284 odběratelů infokanálu), které posloužily jako zadání a prototyp. Kód se nepřenáší — píše se znovu tak, aby ho mohla provozovat **kterákoliv obec jako jeden balík na vlastním serveru**, s testy, dokumentací a bez závislosti na jedné osobě.

- Licence: **EUPL-1.2** (evropská veřejná licence, česky dostupná)
- Stav: **etapa 1 rozpracovaná** — účty (OIDC), infokanál, **úřední deska + povinně zveřejňované informace**, **obecní web (redakční systém)** a **import ze starých webů** (WordPress, Galileo). Podrobně v [docs/STAV.md](docs/STAV.md).
- Testovací instalace: https://dev.vlastiborice.cz (chráněno HTTP heslem)

Licence **EUPL-1.2** byla potvrzena vlastníkem projektu 13. 10. 2026. Anglické znění je v `LICENSE`, oficiální české znění v `LICENSE.cs.txt` (všechna jazyková znění EUPL jsou rovnocenná).

## Pro koho

Pro obce do několika tisíc obyvatel, které chtějí vlastní digitální služby bez drahého dodavatele: jeden `docker compose up` na levném VPS, konfigurace obce v jednom souboru (`obec.yml`), SMS přes komerční bránu s API (SMSbrána.cz, GoSMS, SMS Manager…), žádné cizí skripty na stránkách (soukromí občanů), přístupnost WCAG 2.1 AA.

## Rychlý start (vývoj)

Potřebujete Docker (Node 22 se spouští v kontejneru, na počítači nemusí být).

```bash
git clone <repozitář> platforma && cd platforma
cp .env.example .env && cp obec.example.yml obec.yml
# vygenerujte tajemství: openssl rand -hex 32 (SESSION_SECRET, OIDC_COOKIE_SECRET, OIDC_PLATFORMA_SECRET)
docker compose -f docker-compose.dev.yml up            # Postgres + aplikace s automatickým restartem
# → http://localhost:3000 ; SMS kódy se vypisují do logu a (s OTP_DEV_ZOBRAZIT=1) přímo na stránce
```

Testy, lint a build (v kontejneru s Node 22):

```bash
./dev.sh npm test        # Vitest — vyžaduje Postgres (TEST_DATABASE_URL)
./dev.sh npm run lint    # ESLint + Prettier
./dev.sh npm run build   # TypeScript → dist/
```

Podrobnosti: [docs/VYVOJ.md](docs/VYVOJ.md).

## Instalace na vlastní server obce

```bash
cp .env.example .env     # vyplnit DOMENA, POSTGRES_PASSWORD, tajemství, SMS bránu, SMTP
cp obec.example.yml obec.yml   # profil obce
docker compose up -d     # aplikace + PostgreSQL + Caddy s automatickým HTTPS
```

Krok za krokem v [docs/INSTALACE.md](docs/INSTALACE.md).

## Dokumentace

| Soubor                                       | Obsah                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md) | Rozhodnutí (ADR) s odůvodněním, mapa modulů, datový model jádra            |
| [docs/MODULY.md](docs/MODULY.md)             | Seznam modulů, priority, požadavky převzaté z provozu a zákonné povinnosti |
| [docs/INSTALACE.md](docs/INSTALACE.md)       | Instalace na vlastní server, zálohy, aktualizace, monitoring               |
| [docs/VYVOJ.md](docs/VYVOJ.md)               | Vývojové prostředí, struktura kódu, testy, jak přidat modul / SMS bránu    |
| [docs/STAV.md](docs/STAV.md)                 | Co je hotové, co ne, plán etapy 1                                          |
| [docs/IMPORT.md](docs/IMPORT.md)             | Import ze starých webů (WordPress, Galileo), jak napsat adaptér            |
| [CHANGELOG.md](CHANGELOG.md)                 | Změny podle verzí                                                          |

## Technologie

Node.js 22 + TypeScript, Fastify, PostgreSQL 16 (Kysely — typovaný SQL, explicitní migrace, fulltext s `unaccent`), šablony Eta (server-side, progressive enhancement, minimum JavaScriptu), editor Quill 2 (vendorovaný), sharp (obrázky), sanitize-html, OpenID Connect provider `oidc-provider` (certifikovaná knihovna), Vitest, ESLint + Prettier, pino, Docker (multi-stage, bez root uživatele), Caddy.

## Jak přispět

Projekt je otevřený. Chyby a nápady hlaste v issues; změny posílejte jako pull request (CI pustí lint, testy a build). Veškerý text pro lidi — kód, komentáře, dokumentace, commit zprávy — je **česky**.
