# Zpravodaj → web: rozhraní pro sazbu (návrh 22. 10. 2026)

Obecní zpravodaj sází Claude v Typstu (mimo tento repozitář). Po vysázení má nové číslo samo vzniknout na webu
obce jako příspěvek v kategorii „Zpravodaj“ s PDF, obálkou, obsahem čísla a **strukturovanými údaji**, které web
používá jinde (počet obyvatel v úvodu, akce v kalendáři). Web nic z PDF nehádá — vše dostane v metadatech.

## Volání

`POST {BASE_URL}/api/zpravodaj` · `Authorization: Bearer <ZPRAVODAJ_API_TOKEN>` (env; platforma má i obecný
mechanismus tokenů pro integrace — viz „Rozhodnutí“) · `multipart/form-data`:

| pole       | povinné | obsah                                                                    |
| ---------- | ------- | ------------------------------------------------------------------------ |
| `metadata` | ano     | JSON (schéma níže) — soubor nebo textové pole                            |
| `pdf`      | ano     | webová verze PDF (zmenšená, do ~10 MB)                                   |
| `pdf_tisk` | ne      | tisková verze (bez ořezových značek), jen ke stažení                     |
| `obalka`   | ne      | PNG/JPG první strany (např. 1200 px na výšku) → úvodní obrázek příspěvku |

Odpověď `201 {"id": "...", "url": "https://…/aktuality/obecni-zpravodaj-2026-3", "stav": "zverejneno|koncept"}`.
Chyby `400` s popisem pole, `401` špatný token, `413` moc velký soubor.
**Idempotence:** stejné `rocnik` + `cislo` = aktualizace existujícího příspěvku (nová revize, staré soubory
zůstávají v historii), ne duplicita. Ukázka:

```bash
curl -sS https://vlastiborice.cz/api/zpravodaj -H "Authorization: Bearer $TOKEN" \
  -F metadata=@zpravodaj-2026-3.json -F pdf=@2026-03-web.pdf -F pdf_tisk=@2026-03-tisk.pdf -F obalka=@obalka.png
```

## Metadata (JSON)

Vzor podle čísla **3/2026** (září 2026). Jména soukromých osob se **neposílají** (přihlášení/odhlášení jen počty).

```json
{
  "rocnik": 2026,
  "cislo": 3,
  "titulek": "Obecní zpravodaj 3/2026",
  "vydano": "2026-09-08",
  "obdobi": "září 2026",
  "perex": "Volby 2026, posilovna v KD, mokřad na Jivině, pozvánky na podzim, fotogalerie z léta.",
  "obsah": [
    { "strana": 2, "nadpis": "Úvodník & info OÚ" },
    { "strana": 3, "nadpis": "Evidence & hospodaření" },
    { "strana": 4, "nadpis": "Volby 2026" },
    { "strana": 20, "nadpis": "Jóga & kalendář" }
  ],
  "evidence": {
    "k": "2026-08-31",
    "obyvatel": 353,
    "pred_rokem": 344,
    "pred_5_lety": 300,
    "pred_10_lety": null,
    "pred_20_lety": null,
    "prihlaseni": 5,
    "odhlaseni": 0,
    "narozeni": 0,
    "umrti": 0
  },
  "hospodareni": {
    "k": "2026-08-31",
    "prijmy": 8187503.46,
    "vydaje": 6930504.52,
    "saldo": 1256998.94,
    "zustatek_ucet": null,
    "zustatek_pokladna": null
  },
  "akce": [
    {
      "nazev": "Obecní výlet – zámek Litomyšl",
      "datum": "2026-10-03",
      "od": "07:30",
      "misto": "odjezd Vlastibořice (DPS), 7:35 Jivina",
      "poznamka": "přihlášky na OÚ do 14. 9."
    },
    {
      "nazev": "Volby do zastupitelstva obce",
      "datum": "2026-10-09",
      "datum_do": "2026-10-10",
      "misto": "budova obecního úřadu"
    },
    {
      "nazev": "Clapton & Dylan at Kulturák",
      "datum": "2026-10-16",
      "od": "18:00",
      "misto": "Kulturní dům",
      "poznamka": "Santal 18:00, The Boband 20:00, vstupné 200 Kč"
    },
    {
      "nazev": "Powerjóga s Veru Vanclovou",
      "pravidelne": "každé pondělí",
      "od": "18:30",
      "misto": "Kulturní dům",
      "odkaz": "https://www.vanclovi.cz",
      "od_data": "2026-09-07"
    }
  ],
  "tiraz": {
    "vydavatel": "Obec Vlastibořice",
    "redakce_email": "zpravodaj@vlastiborice.cz",
    "design": "Mgr. Lucie Koutníková, Dušan Koutník",
    "korektura": "Mgr. Lucie Koutníková",
    "foto_obalka": "Dušan Koutník",
    "evidence_mk": "MK ČR E 20317"
  },
  "zverejnit": true,
  "rozeslat": false
}
```

Povinné: `rocnik`, `cislo`, `vydano`, `perex`, `evidence.obyvatel` (+ `evidence.k`). Vše ostatní nepovinné;
co chybí, web vynechá. `obsah` dává seznam kapitol s čísly stran, `akce` jen **budoucí** akce z kalendáře
v čísle (web si poradí s duplicitami — viz níže). `zverejnit: false` = příspěvek vznikne jako koncept ke
kontrole; `rozeslat: true` = po zveřejnění vznikne hlášení infokanálu „Vyšel nový zpravodaj“ s odkazem.

## Co web s daty udělá

- **Příspěvek** (kategorie `zpravodaj`): titulek, úvodní obrázek z obálky, perex, blok „V tomto čísle“ (obsah
  se stranami), odkazy ke stažení (web / tisk, velikost), tabulka „Z evidence obyvatel k …“ a „Hospodaření k …“
  (jen čísla, nic osobního), tiráž. Zdroj příspěvku `zpravodaj`, metadata uložená u příspěvku (`web_zpravodaj`).
- **Počet obyvatel v úvodu** = `evidence.obyvatel` z **nejnovějšího** čísla (podle `vydano`), popisek
  „obyvatel“ s titulkem „podle Zpravodaje 3/2026 (k 31. 8. 2026)“; odkaz dál na Můj účet. Hodnota z `obec.yml`
  se použije jen dokud žádné číslo s metadaty není. Starší čísla (import z WordPressu) metadata nemají —
  u čísla 3/2026 je doplněna ručně (353).
- **Akce** z `akce`: každá se porovná s kalendářem (stejný den + podobný název) — existující se nezakládá,
  nová vznikne jako koncept „ke zpracování“ stejně jako akce z rezervací (docs/AKCE-PROPOJENI.md). Pravidelné
  (`pravidelne`) jen jako poznámka v příspěvku, do kalendáře ne (ty žijí v rezervacích).

## Co má sázecí Claude mít v hlavičce Typstu

Aby metadata nevznikala ručně, drží se v Typstu jako jeden slovník na začátku čísla (zdroj pravdy pro sazbu
i pro web): ročník, číslo, datum vydání, období, perex, kapitoly (nadpis + strana se dopočítá), evidence
obyvatel (k datu, počty), hospodaření (k datu, částky), kalendář akcí (strukturovaně, ne jako text), tiráž.
Z něj se při exportu vygeneruje `zpravodaj-RRRR-C.json` + PNG obálky (`typst compile --pages 1 --format png`)
a zavolá se `curl` výše. Token dostane sázecí prostředí jednou (proměnná `ZPRAVODAJ_API_TOKEN`), nikdy do gitu.

## Rozhodnutí

- Implementace až po sloučení větve `akce-propojeni` (stejná oblast: migrace, akce, rozesílka z příspěvku).
- Tokeny integrací: první verze `ZPRAVODAJ_API_TOKEN` v env; cílově tabulka `integrace_tokeny` (název, hash,
  oprávnění, poslední použití) spravovaná ve Správě — stejný mechanismus se bude hodit pro rezervace a další.
