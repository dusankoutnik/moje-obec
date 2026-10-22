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
