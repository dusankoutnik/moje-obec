# Převod účtů z MůjÚčtu do platformy

Skript `src/scripts/prevod-mujucet.ts` přenese tabulku `users` aplikace MůjÚčet (SQLite) do `uzivatele`.
Logika je v `src/moduly/ucty/prevod.ts` (testy `test/prevod-mujucet.test.ts`).

## Spuštění

```bash
# DATABASE_URL (+ povinné proměnné platformy) musí mířit na cílovou instanci; skript sám spustí migrace
npx tsx src/scripts/prevod-mujucet.ts /cesta/mujucet.db --nanecisto              # jen počty, nic se neuloží
npx tsx src/scripts/prevod-mujucet.ts /cesta/mujucet.db --anonymizovat           # dev / testovací instalace
npx tsx src/scripts/prevod-mujucet.ts /cesta/mujucet.db                          # ostrý převod
```

- Zdroj se čte jen pro čtení (`node:sqlite`, Node ≥ 22.5; bez nativních závislostí). Převádějte **kopii** snímku
  (u WAL databáze i s `-wal`/`-shm`). Výpis obsahuje jen počty a čísla účtů, žádné osobní údaje.
- Celý převod běží v jedné transakci; `--nanecisto` ji na konci zruší.
- **Idempotentní** podle `cislo`: opakovaný běh účty aktualizuje (MůjÚčet je do přepnutí zdroj pravdy). Heslo, které už
  platforma po přihlášení přepočítala, se nepřepíše; GDPR souhlas a ověření telefonu se prázdnou hodnotou nemažou.

## Co se převádí

| MůjÚčet                                                                                | platforma                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                                   | `cislo` (= `mujucet_id` v claims, id v rezervacích a eKnihách)                                                                                                                     |
| `first_name`, `last_name` (u starých účtů rozdělené `name`, poslední slovo = příjmení) | `jmeno`, `prijmeni`                                                                                                                                                                |
| `nickname`, `phone` (E.164), `email`, `village`                                        | `prezdivka`, `telefon`, `email`, `cast_obce`                                                                                                                                       |
| `roles` + `role`                                                                       | `role` — admin, spravce, ucetni, redaktor, vstupne; **spravce a redaktor dostanou i `web` a `deska`** (jako dnešní redaktoři platformy; `--redaktor-bez-webu` u redaktora vynechá) |
| `is_resident`, `rezident_posouzen_at`, `rezident_posouzen_by`                          | `rezident`, `rezident_posouzen_at`, `rezident_posouzen_by`                                                                                                                         |
| `gdpr_consent_at`, `verified_at`, `blocked_at`, `created_at`                           | `gdpr_souhlas_at`, `telefon_overen_at`, `blokovan_at`, `vytvoren_at` (místní čas Europe/Prague → UTC)                                                                              |
| `password_hash` (`sůl:hash`)                                                           | `heslo_hash` `scrypt$16384$8$1$sůl$hash`                                                                                                                                           |
| `color`, `icon`, `eknihy_sms`, `ekey_email_odmitnut`, `rezident_avizo_at`, `role`      | `navic` (jsonb, `zdroj: "mujucet"`)                                                                                                                                                |

- **Hesla:** MůjÚčet používá `crypto.scryptSync(heslo, sůl, 64)` (N=16384, r=8, p=1, sůl = hex text) — stejný
  algoritmus jako platforma, jen slabší parametry. Hash se převede do formátu platformy, `overHeslo` ho ověří a po
  úspěšném přihlášení ho `potrebujeRehash` přepočítá na N=2^15, p=3. Žádná nová závislost.
- **Vynechá se:** GDPR vymazané účty (`name = '[vymazáno]'` nebo telefon `smazano-…`).
- `verified_at` MůjÚčet nastavoval i po přihlášení kódem na e-mail — převádí se jako ověřený telefon; e-mail se jako
  ověřený neoznačí.

## Konflikty a čísla účtů

- Sekvence `uzivatele_cislo_seq` se posune za nejvyšší id MůjÚčtu → nové účty dostávají další volné číslo.
- Účet platformy, který z MůjÚčtu nepochází (demo, ručně založený) a má číslo z rozsahu MůjÚčtu, se **přečísluje**
  (údaje se nemění) — počet `precislovano`.
- Telefon už má jiný účet platformy → **konflikt, účet se nepřevede** (vypíše se číslo). `--sloucit-telefonem` místo
  toho připojí údaje MůjÚčtu ke stávajícímu účtu (dostane číslo z MůjÚčtu, role se sjednotí) — použít jen tam, kde je
  jasné, že jde o stejného člověka (např. admin účet založený na platformě před převodem).
- E-mail už má jiný účet → účet se převede **bez e-mailu** a vypíše se konflikt.

## Anonymizace (`--anonymizovat`, dev)

Jméno „Občan“, příjmení = číslo účtu, přezdívka „Občan <číslo>“, telefon `+42077<7 číslic z čísla účtu>`,
e-mail `ucet<číslo>@dev.invalid` (jen kde e-mail byl), hesla zahozena, `ekey_email_odmitnut` nahrazen. Čísla účtů,
role, rezident a časy zůstávají, takže vazby z rezervací a eKnih sedí. Demo účty devu (777 000 0xx) s anonymními
telefony nekolidují; mají-li číslo z rozsahu MůjÚčtu, přečíslují se.

## Zkušební převod (snímek 22. 10. 2026, testovací DB)

Zdroj 302 účtů: 7 vymazaných vynecháno, **295 založeno**, 0 konfliktů, 21 s heslem (bez `--anonymizovat`),
261 rezidentů, 5 s rolemi, sekvence na 303. Druhý běh: 0 založeno, 295 aktualizováno (stejně s `--anonymizovat`).

## Po převodu

1. `GET /api/interni/uzivatel/1` (s `x-api-secret`) — zkontrolovat role a rezidenta.
2. Přihlášení heslem jednoho převedeného účtu → hash v DB začíná `scrypt$32768$8$3$`.
3. Aplikace (rezervace, eKnihy) párují uživatele podle claimu `mujucet_id`.

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
