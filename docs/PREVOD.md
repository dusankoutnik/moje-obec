# Převod dat ze stávajících aplikací obce

Převodní skripty jsou idempotentní (opakované spuštění nic nezdvojí), mají `--nanecisto` (proběhne v transakci,
která se vrátí — počty jsou skutečné) a `--anonymizovat` (vývojová kopie: jména, telefony a e-maily nahrazené,
stejná id a vazby). Vypisují jen počty, nikdy osobní údaje. Spouštět jen na kopii databáze aplikace.

## Infokanál (VlastiKanál)

```
node dist/scripts/prevod-vlastikanal.js /cesta/vlastikanal.db --nanecisto
node dist/scripts/prevod-vlastikanal.js /cesta/vlastikanal.db              # ostře (dev: + --anonymizovat)
node dist/scripts/prevod-vlastikanal.js --doparovat                       # po převodu účtů (uzivatele.cislo)
```

SQLite se čte přes `node:sqlite` jen pro čtení. Pozor, VlastiKanál běží ve WAL — kopie databáze musí být
konzistentní snímek (`better-sqlite3 .backup()`), ne `cp` samotného `.db`.

| VlastiKanál                                | platforma                                                 | poznámka                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribers`                              | `ik_odberatele`                                           | `prevod_id` = id VK; párování prevod_id → telefon → e-mail                                                                                                                                                                              |
| `name, phone, email, village`              | `jmeno, telefon (E.164), email (malá písmena), cast_obce` | e-mail obsazený jiným odběratelem se neuloží (počet `emailuObsazenych`)                                                                                                                                                                 |
| `channel_pref` sms/mixed/email             | `kanal` sms/smisene/email                                 |                                                                                                                                                                                                                                         |
| `verified_at, unsubscribed_at, consent_at` | `overen_at, odhlasen_at, souhlas_at`                      | časy VK jsou místní (Praha), `consent_at` i ve tvaru `DD.MM.RRRR HH:MM:SS`                                                                                                                                                              |
| `consent_type, note`                       | `poznamka` („Převedeno z VlastiKanálu. Souhlas: …“)       | při `--anonymizovat` bez poznámky                                                                                                                                                                                                       |
| `source` infokanal/mujucet/sms/urad/web    | `zdroj` import/ucet/sms/urad/web                          |                                                                                                                                                                                                                                         |
| `token`                                    | `token`                                                   | zachován (odhlašovací odkazy ze starých e-mailů)                                                                                                                                                                                        |
| `user_id` (číslo účtu MujÚčtu)             | `mujucet_cislo` + `uzivatel_id`                           | vazba podle `uzivatele.cislo`; dokud účty nejsou převedené, uloží se jen číslo a dopáruje se `--doparovat` (nebo dalším během převodu)                                                                                                  |
| `categories`                               | `ik_kategorie`                                            | `dulezite→hlaseni`, `cviceni→sport`, `krizove, kultura, sluzby, pocasi, elektrina, voda` stejně; neznámé se založí                                                                                                                      |
| `optouts`                                  | `ik_optouty`                                              | zrcadlo zdroje (u povinných kategorií se ignorují)                                                                                                                                                                                      |
| `messages`                                 | `ik_hlaseni`                                              | `prevod_id`; `done→hotovo`, ostatní → `zruseno` (nic se znovu nerozešle, původní stav v souhrnu); cíl `all→vse`, `villages→casti`, `custom→vybrani`; `auto_source` ČEZ/SčVK/ČHMÚ → `cez/voda/chmu`; autor podle `admins.user_id` → účet |
| `recipients`                               | `ik_hlaseni.souhrn`                                       | jen počty podle kanálu a stavu + odkaz na článek (`wp_url`)                                                                                                                                                                             |
| `outbox`, `otp`, `kv`, `audit_log`         | —                                                         | nepřevádí se (fronta odesílacího API má být před přechodem prázdná)                                                                                                                                                                     |

**Zkušební převod snímku 22. 10. 2026** (do testovací DB, anonymizovaně): 289 odběratelů, 0 bez kontaktu,
0 obsazených e-mailů, 285 s číslem účtu MujÚčtu (spárují se po převodu účtů), 0 nových kategorií, 251 opt-outů,
24 hlášení (všechna dokončená). Druhý běh: 0 nových, vše jen aktualizováno.

### Po přechodu (provoz)

1. `INTERNI_API_SECRET` v env platformy i aplikací (rezervace), `APLIKACE_REZERVACE_URL` (nebo
   `SPOLUJIZDA_HOOK_URL` + `SPOLUJIZDA_HOOK_SECRET`, pokud rezervace přijímají ODVOZ na staré adrese
   `/api/spolujizda/poptavka`).
2. `SMS_PROVIDER=smsgate` + `SMSGATE_URL/USER/PASS`, `BRANA_NOTIFY`, případně `SMSGATE_WEBHOOK_KLIC`.
3. Webhooky SMSGate přepojit na platformu: `node dist/scripts/smsgate-webhook.js` (výpis) →
   `--zapsat` → starý webhook VlastiKanálu `--smazat <id>`.
4. `texty.sms_prefix` v `obec.yml` (dřív `VLASTIKANAL: `).
