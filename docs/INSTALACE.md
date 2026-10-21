# Instalace na vlastní server obce

Cíl: obec si pronajme levný VPS (2 vCPU, 4 GB RAM stačí, Ubuntu 24.04), nasměruje na něj doménu a spustí jeden `docker compose up`. Vše ostatní (HTTPS, databáze, migrace) se postará samo.

## 1. Předpoklady

- Server s veřejnou IP adresou a Dockerem (Docker Engine 24+ s Compose v2): `curl -fsSL https://get.docker.com | sh`
- DNS záznam A `obec.example.cz` → IP serveru (Caddy si pak sám vyřídí certifikát Let's Encrypt).
- Otevřené porty 80 a 443.
- Účet u SMS brány s API (SMSbrána.cz, GoSMS.eu nebo SMS Manager) a SMTP účet pro e-maily (typicky od hostingu domény).
- Neprovozujte jako root: založte uživatele ve skupině `docker`.

## 2. Soubory

```bash
sudo mkdir -p /opt/moje-obec && sudo chown $USER /opt/moje-obec && cd /opt/moje-obec
git clone https://github.com/<organizace>/platforma .     # nebo rozbalit vydání
cp .env.example .env
cp obec.example.yml obec.yml
chmod 600 .env
```

### `.env` — tajné a instalační hodnoty

| Proměnná                                                        | Význam                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DOMENA`                                                        | doména instalace, např. `obec.example.cz` (pro Caddy)                                                                  |
| `ACME_EMAIL`                                                    | e-mail pro Let's Encrypt (upozornění na expiraci)                                                                      |
| `BASE_URL`                                                      | `https://obec.example.cz` — veřejná adresa, z ní se odvozuje OIDC issuer                                               |
| `POSTGRES_PASSWORD`                                             | heslo databáze (`openssl rand -hex 16`)                                                                                |
| `SESSION_SECRET`, `OIDC_COOKIE_SECRET`, `OIDC_PLATFORMA_SECRET` | tajemství, každé jiné: `openssl rand -hex 32`                                                                          |
| `SMS_PROVIDER` + údaje brány                                    | `smsbrana` (`SMSBRANA_LOGIN/PASSWORD`), `gosms` (`GOSMS_CLIENT_ID/SECRET/CHANNEL`), `smsmanager` (`SMSMANAGER_APIKEY`) |
| `SMS_ODESILATEL`                                                | odesílatel (SMSbrána: `sender_id`; SMS Manager: registrovaný textový odesílatel)                                       |
| `MAIL_PROVIDER=smtp` + `SMTP_*`, `MAIL_FROM`                    | odesílání e-mailů                                                                                                      |
| `NODE_ENV=production`                                           | v produkci vždy; `OTP_DEV_ZOBRAZIT` musí být `0`                                                                       |
| `SMS_WEBHOOK_TOKEN`                                             | nepovinné: tajná část adresy webhooku doručenek (`openssl rand -hex 24`); prázdné = odvodí se ze `SESSION_SECRET`      |
| `SMSMANAGER_WEBHOOK_SECRET`                                     | SMS Manager: `default_callback_secret` z jejich administrace — webhook pak ověřuje podpis `X-Request-Signature`        |
| `SMS_POVOLENE_PREDVOLBY`                                        | na jaká čísla smí jít SMS s kódem, výchozí `+420,+421` (ochrana před zneužitím na drahá zahraniční čísla)              |
| `SMS_DENNI_LIMIT_KODU`                                          | nejvýš kolik SMS s kódy za 24 h pro celou instalaci (výchozí 300); při vyčerpání přijde správcům e-mail                |
| `OTP_COOLDOWN_S`                                                | minimální odstup dvou kódů na stejné číslo v sekundách (výchozí 60)                                                    |

Obraz Dockeru má `NODE_ENV=production` sám; ostrá instalace s `SMS_PROVIDER=konzole` (bez SMS brány) se odmítne spustit — výjimkou je testovací instalace s `OTP_DEV_ZOBRAZIT=1`.

### Webhook doručenek SMS

Adresa, kam brána posílá doručenky, je `https://obec.example.cz/webhook/sms/<tajemství>`. Tajemství je `SMS_WEBHOOK_TOKEN`, a když není nastavené, odvodí se ze `SESSION_SECRET` (HMAC). Zjistíte ho:

```bash
docker compose exec app node -e "import('./dist/moduly/infokanal/index.js').then(m => console.log(m.tajemstviWebhooku(process.env)))"
```

**Změna oproti verzím do 2026-10:** dřív byla tajemstvím přímo část `SESSION_SECRET`; po aktualizaci se adresa webhooku změní a je potřeba ji v administraci SMS brány přepsat (jinak se doručenky budou dál stahovat jen pravidelným dotazem à 5 minut). Adresa se změní i při změně `SESSION_SECRET` — proto je pro ostrý provoz lepší nastavit vlastní `SMS_WEBHOOK_TOKEN`.

### `obec.yml` — profil obce

Název, IČO, adresa, kontakty, bankovní účet, části obce, kód obce (ČSÚ) a ORP (pro výstrahy), pověřenec GDPR, zapnuté moduly, texty (název infokanálu, SMS prefix), odkazy v patičce. Soubor je komentovaný; chybná hodnota zastaví start s českou chybou.

### Kvíz — vlastní otázky obce

Modul zapnete v `obec.yml` (`moduly.kviz: true`). Veřejné otázky jsou v obrazu (`kviz-otazky/`), vlastní balíky obce
(místní otázky) dejte do adresáře mimo repozitář, připojte ho do kontejneru jen pro čtení a nastavte `KVIZ_BALIKY`
(např. volume `./kviz:/app/kviz-instance:ro` + `KVIZ_BALIKY=/app/kviz-instance`). Balíky se načítají při startu;
po úpravě souboru stačí Správa → Kvíz → „Načíst balíky znovu“.

## 3. Spuštění

```bash
docker compose up -d
docker compose logs -f app      # čekejte na „Moje obec 2.0 běží“
curl -s https://obec.example.cz/healthz   # {"stav":"ok",…}
```

Migrace databáze proběhnou při každém startu automaticky (idempotentně).

### První správce

```bash
docker compose exec app node dist/scripts/seed.js +420777123456
```

Založí účet s rolí `admin` na dané číslo a čtyři ukázkové odběratele infokanálu (na ostré instalaci je smažte v administraci). Přihlaste se na `https://obec.example.cz/prihlaseni` tímto telefonem — přijde SMS kód.

## 4. Za vlastní reverzní proxy (bez Caddy)

Použijte `docker-compose.dev-server.yml` jako vzor: služba `platforma` bez veřejného portu na sdílené síti s proxy, proxy posílá `X-Forwarded-Proto: https` (aplikace má `trustProxy`). `INTERNAL_BASE_URL=http://127.0.0.1:3000` zajistí, že si aplikace pro OIDC token endpoint nevolá přes proxy.

`TRUST_PROXY_HOPS` musí odpovídat počtu proxy před aplikací (Caddy nebo jedna vlastní proxy = `1`, výchozí). Kdyby aplikace byla dostupná **přímo bez proxy**, nastavte `0` — jinak by si klient mohl hlavičkou `X-Forwarded-For` vymyslet adresu a obejít limity pokusů. Port aplikace nikdy nevystavujte do internetu vedle proxy.

## 5. Zálohy

Stav instalace je na **třech místech** a zálohovat je třeba všechna:

1. **databáze** (účty, hlášení, úřední deska, obsah webu) — volume `db_data`, zálohovat přes `pg_dump`, ne kopírováním souborů;
2. **nahrané soubory obce** (přílohy úřední desky, fotky, loga, videa) — volume `app_data` (v kontejneru `/app/data`);
3. **konfigurace** `.env` a `obec.yml` (bez `.env` nejde obnovit přihlášení — cookie tajemství) a volume `caddy_data` (certifikáty a účet Let's Encrypt; bez něj se certifikát vystaví znovu, ale při opakovaných obnovách hrozí limit Let's Encrypt).

Názvy volumes mají předponu podle adresáře instalace (`/opt/moje-obec` → `moje-obec_app_data`); ověřte je příkazem `docker volume ls`.

Denní záloha skriptem `/opt/moje-obec/zaloha.sh` (spouští uživatel ve skupině `docker`):

```bash
#!/bin/sh
set -eu
cd /opt/moje-obec
mkdir -p zalohy && chmod 700 zalohy
D=$(date +%F)
docker compose exec -T db pg_dump -U platforma -Fc platforma > zalohy/db-$D.dump
docker run --rm -v moje-obec_app_data:/data:ro -v "$PWD/zalohy":/z alpine tar czf /z/soubory-$D.tar.gz -C /data .
docker run --rm -v moje-obec_caddy_data:/data:ro -v "$PWD/zalohy":/z alpine tar czf /z/caddy-$D.tar.gz -C /data .
tar czf zalohy/konfigurace-$D.tar.gz .env obec.yml
find zalohy -name '*-*.dump' -mtime +30 -delete
find zalohy -name '*-*.tar.gz' -mtime +30 -delete
```

```bash
chmod 700 /opt/moje-obec/zaloha.sh
# /etc/cron.d/moje-obec-zaloha  (v crontabu se % musí psát jako \%; skript to obchází)
15 3 * * * obec /opt/moje-obec/zaloha.sh
```

Zálohy kopírujte i **mimo server** (rsync na jiný stroj, objektové úložiště) — záloha na stejném disku neochrání před ztrátou serveru. Obsahují osobní údaje a tajemství: šifrovat a omezit přístup. Jednou za čas obnovu vyzkoušejte na jiném stroji.

Databáze potřebuje rozšíření `unaccent` (hledání bez diakritiky); migrace ho zakládá sama — obraz `postgres:16-alpine` ho obsahuje a vlastník databáze ho smí vytvořit. U spravovaného Postgresu (cloud) ověřte, že je rozšíření povolené.

### Obnova

Obnovuje se **při zastavené aplikaci** (jinak by do databáze během obnovy zapisovala — fronta hlášení, sezení):

```bash
cd /opt/moje-obec
docker compose stop app
# databáze: --clean smaže a znovu založí objekty ze zálohy
docker compose exec -T db pg_restore -U platforma -d platforma --clean --if-exists < zalohy/db-2026-10-13.dump
# soubory obce
docker run --rm -v moje-obec_app_data:/data -v "$PWD/zalohy":/z alpine sh -c 'tar xzf /z/soubory-2026-10-13.tar.gz -C /data'
docker compose start app
docker compose logs -f app     # migrace doběhnou, čekejte na „Moje obec 2.0 běží“
```

Na novém serveru: nejdřív vrátit `.env` a `obec.yml` (a případně `caddy_data`), `docker compose up -d db`, obnovit databázi a soubory jako výše, pak `docker compose up -d`.

## 6. Aktualizace

```bash
git pull            # nebo stáhnout nové vydání
docker compose build app && docker compose up -d app
```

Migrace se pustí při startu. Před velkou aktualizací vždy záloha (bod 5). Rollback: `git checkout <předchozí tag>` + build + obnova DB.

## 7. Monitoring

- `GET /healthz` → `200 {"stav":"ok"}`; při nedostupné DB `503`. Hlídejte zvenku (UptimeRobot apod.).
- Logy: `docker compose logs app` (JSON řádky, pino). Chyby mají `level: 50`.
- Paměť: aplikace ~150 MB, Postgres s `shared_buffers=64MB` ~100 MB.
- Docker healthcheck restartuje aplikaci, když `/healthz` neodpovídá.

## 8. Bezpečnostní minimum serveru

SSH jen klíčem, bez root loginu; `ufw` povolit jen 22/80/443; automatické bezpečnostní aktualizace (`unattended-upgrades`); `.env` s právy 600; zálohy mimo server; nikdy nenastavovat `OTP_DEV_ZOBRAZIT=1` v produkci (aplikace to odmítne).
