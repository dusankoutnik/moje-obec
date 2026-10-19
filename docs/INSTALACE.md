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

### `obec.yml` — profil obce

Název, IČO, adresa, kontakty, bankovní účet, části obce, kód obce (ČSÚ) a ORP (pro výstrahy), pověřenec GDPR, zapnuté moduly, texty (název infokanálu, SMS prefix), odkazy v patičce. Soubor je komentovaný; chybná hodnota zastaví start s českou chybou.

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

## 5. Zálohy

Databáze je jediný stav (soubory se zatím neukládají). Denní záloha cronem:

```bash
# /etc/cron.d/moje-obec-zaloha
15 3 * * * obec cd /opt/moje-obec && docker compose exec -T db pg_dump -U platforma -Fc platforma > zalohy/db-$(date +\%F).dump && find zalohy -name 'db-*.dump' -mtime +30 -delete
```

**Nahrané soubory obce** (přílohy úřední desky, fotky, loga) nejsou v databázi, ale ve volume `app_data` (v kontejneru `/app/data`). Zálohujte ho také, např. denně:

```bash
docker run --rm -v moje-obec_app_data:/data -v $PWD/zalohy:/z alpine tar czf /z/soubory-$(date +%F).tar.gz -C /data soubory
```

Databáze potřebuje rozšíření `unaccent` (hledání bez diakritiky); migrace ho zakládá sama — obraz `postgres:16-alpine` ho obsahuje a vlastník databáze ho smí vytvořit. U spravovaného Postgresu (cloud) ověřte, že je rozšíření povolené.

Obnova: `docker compose exec -T db pg_restore -U platforma -d platforma --clean < zalohy/db-2026-10-13.dump`. Zálohy ukládejte i mimo server (rsync na jiný stroj / objektové úložiště). Záloha musí obsahovat i `.env` a `obec.yml` (jinak nelze obnovit přihlášení — podpisové klíče OIDC jsou v DB, ale cookie tajemství v `.env`).

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
