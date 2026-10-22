# Text dokumentů a vyhledávání v nich (návrh 22. 10. 2026)

## Dnešní stav
Vyhledávání `/hledat` prochází jen stránky a aktuality (titulek, perex, HTML), názvy a popisy dokumentů úřední desky
a názvy souborů ke stažení. **Obsah PDF a kancelářských souborů se neprohledává.** Na pilotu je 829 PDF (548 MB),
76 Wordů, 7 tabulek; část PDF jsou skeny bez textové vrstvy.

## Cíl
Každý nahraný dokument dostane **text** (z textové vrstvy, nebo OCR, když vrstva chybí), text se **naindexuje** a
vyhledávání ho najde s úryvkem a odkazem na místo, kde dokument na webu je (úřední deska, dokumenty, článek).
Vše běží **lokálně** na serveru obce (žádná cloudová služba), na pozadí, aby nahrání nečekalo.

## Nástroje (v obrazu Dockeru, Debian bookworm)
`poppler-utils` (pdftotext, pdftoppm, pdfinfo), `tesseract-ocr` + `tesseract-ocr-ces` + `tesseract-ocr-eng` (OCR
česky i anglicky), `antiword` (starý Word `.doc`). Kancelářské formáty ZIP/XML (`.docx .xlsx .pptx .odt .ods`) se
čtou přímo v Node (malá knihovna pro ZIP, např. `fflate`, MIT — zapsat do `docs/LICENCE-TRETICH-STRAN.md`).
Obrázky nahrané jako dokument (sken ve formátu JPG/PNG) jdou rovnou do OCR.

## Datový model
- `soubory_text` (`soubor_id` PK → `soubory`, `stav` `ceka|zpracovava|hotovo|bez_textu|nepodporovano|chyba`,
  `zdroj` `vrstva|ocr|docx|xlsx|pptx|odt|antiword|obrazek|null`, `text` (do 2 MB), `stran`, `ma_vrstvu` boolean,
  `chyba` text, `pokusu` int, `zarazeno_at`, `zpracovano_at`, `trvani_ms`), generovaný sloupec
  `vyhledavani tsvector = to_tsvector('simple', f_unaccent(lower(text)))` + GIN index (stejně jako web_obsah).
- Po uložení souboru druhu dokument/příloha (PDF, Office, obrázek nahraný jako dokument) vznikne řádek `ceka`
  a worker se „kopne“ (jako fronta infokanálu). Soubory jiného druhu (fotky galerie, loga, videa) se neindexují.

## Zpracování (worker v aplikaci, jeden soubor po druhém, `nice`)
1. **PDF:** `pdfinfo` (počet stran) → `pdftotext -layout` (limit 60 s). Má-li průměr < 40 znaků na stranu → bez
   vrstvy → **OCR**: `pdftoppm -r 200 -png` po stranách (nejvýš `OCR_MAX_STRAN` = 300) → `tesseract -l ces+eng
   --psm 1` na každou stranu, texty spojit; limit 20 min na soubor. PDF s vrstvou i tak projde OCR, když vrstva
   obsahuje hlavně nesmysly (podíl písmen < 50 %) — staré skeny s rozbitou vrstvou.
2. **Office:** docx/xlsx/pptx/odt/ods = ZIP → `word/document.xml`, `xl/sharedStrings.xml` + listy, `ppt/slides/*.xml`,
   `content.xml` → text bez značek; `.doc` → `antiword -t`; `.xls` → zatím `nepodporovano`.
3. **Obrázek jako dokument:** `tesseract` přímo.
4. Výsledek: `hotovo` (+ zdroj), `bez_textu` (OCR < 20 znaků — prázdný sken), `chyba` (zpráva; opakovat nejvýš 3×,
   pak zůstává k ručnímu „znovu“), `nepodporovano`.
5. Rychlá kontrola **hned při nahrání** (PDF, do 5 s, první 3 strany): správce vidí ve zprávě „PDF nemá textovou
   vrstvu, text doplníme na pozadí (OCR, několik minut)“ nebo „textová vrstva v pořádku“; delší kontrola = jen „zkontrolujeme“.
6. Konfigurace env: `TEXT_SOUBORU` (1/0), `OCR_JAZYKY` (`ces+eng`), `OCR_MAX_STRAN` (300), `OCR_DPI` (200),
   `TEXT_MAX_ZNAKU` (2 000 000). Chybí-li binárky, worker zapíše `nepodporovano` s důvodem a správa to ukáže.
7. **Doplnění stávajících souborů:** `src/scripts/text-souboru.ts` (`--vse | --jen-pdf | --znovu-chyby | --id …`)
   jen zařadí do fronty; zpracování běží v aplikaci. Na pilotu stovky PDF → hodiny OCR na pozadí; ukazatel ve správě.

## Vyhledávání
`/hledat` přidá zdroj **„v dokumentech“**: `soubory_text.vyhledavani @@ to_tsquery` (stejný `tsDotaz`), řazení
`ts_rank`, úryvek `ts_headline('simple', f_unaccent(lower(text)), dotaz)` (zvýrazněná slova ~ 200 znaků).
Odkaz vede tam, kde je dokument na webu (v tomto pořadí): příloha úřední desky → `/uredni-deska/<id>` (typ „Úřední
deska“ / „archiv desky“), soubor ke stažení → `/dokumenty#<id>`, článek či stránka s odkazem na soubor (podle
`/soubory/<id>` v HTML) → jeho adresa, jinak přímo soubor. Výsledky z dokumentů se slučují s dnešními podle adresy,
nejvýš 20. Na stránce výsledků poznámka „Prohledáváme i obsah dokumentů (PDF, Word)“.

## Správa
- Správa → Obecní web → **„Text dokumentů“** (`/sprava/web/text-dokumentu`, role `web`/`deska`): počty podle stavu,
  seznam čekajících / chyb / bez textu s tlačítky „Zpracovat znovu“ a „Zpracovat teď“ (přednostně), odhad fronty.
- U dokumentu desky a souboru ke stažení ve správě štítek: „text ✓ (vrstva)“, „text ✓ (OCR)“, „OCR čeká“,
  „bez textu“, „chyba“. Počet čekajících na dashboardu správy.

## Testy a CI
Jednotkové: rozpoznání „bez vrstvy“, parsování Office XML, sestavení příkazů, mapování souboru na stránku, úryvek.
Integrační (`describe.skipIf(!binárky)`): malé PDF s vrstvou, malý sken (PNG → PDF přes `pdftoppm`? ne — přibalit
testovací PDF/PNG v `test/fixtures/`), docx; v CI doinstalovat `poppler-utils tesseract-ocr tesseract-ocr-ces antiword`,
aby integrační testy běžely. Lokálně `./dev.sh` (node slim) je přeskočí.

## Poznámky
- Osobní údaje: index obsahuje jen to, co je v dokumentech veřejně; úryvky ve výsledcích = kontext hledaných slov.
- Paměť: tesseract ~150 MB na stranu; worker po jedné straně, `nice -n 15`; dev kontejner zvýšit na 768 MB.
- Náklady nula, běží na serveru obce; rychlost ~3–8 s na stranu skenu.
