# Import ze starých webů obcí

Bez přenosu obsahu se žádná obec nepřestěhuje. Platforma proto má importní nástroj: **adaptér** přečte starý web
a vrátí obsah v neutrální podobě, **společný importér** ho uloží (média, odkazy, menu, úřední deska, přesměrování).

## Spuštění

```bash
# v kontejneru aplikace (data jdou do její DB a do volume se soubory)
docker exec -e IMPORT_KONTAKT=email@obce.cz platforma \
  node dist/scripts/import.js wordpress https://www.obec.cz --aktuality-od 2024-10-01 --limit-mb 1800
```

| Volba                                       | Význam                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `--aktuality-od 2024-10-01`                 | aktuality od data (výchozí 2 roky zpět)                                           |
| `--deska-od 2020-01-01`                     | úřední deska od data (výchozí vše)                                                |
| `--limit-mb 1800`                           | strop pro stažené soubory; nad ním se další soubory přeskočí (zapíše se do logu)  |
| `--dotace soubor.json`                      | dotace k založení: `[{projekt, poskytovatel, text, odkaz, loga: [{url, alt}]}]`   |
| `--jen stranky,aktuality,deska,menu,dotace` | jen vybrané části                                                                 |
| `--kategorie-desky slug`                    | WordPress: kategorie příspěvků, které tvoří úřední desku (výchozí `uredni-deska`) |
| `--max-stranek 300`                         | Galileo: kolik stálých stránek nejvýš projít                                      |
| `--rozestup-ms 500`                         | rozestup požadavků (500 = 2/s; u cizích webů raději 1000)                         |

Import je **idempotentní** (podle původní URL) — přerušený nebo opakovaný běh nic nezdvojí. Menu se při každém
běhu postaví znovu (staré importované odkazy jdou do koše).

## Co importér dělá (pro všechny adaptéry stejně)

- **Média:** obrázky a dokumenty z vlastního webu obce stáhne (jednou, deduplikace podle URL), zkontroluje typ podle
  obsahu, obrázky přeuloží (zmenšení, bez EXIF/GPS) a odkazy v textu přepíše na `/soubory/…`. Jméno souboru bere
  z parametru `original=` (Galileo `e_download.php`), jinak z cesty.
- **Cizí zdroje** (obrázky z jiných serverů, `<iframe>`, `<object>`, skripty, formuláře) zahodí — obecní web nesmí
  návštěvníky posílat na cizí servery. Odkazy na cizí weby zůstávají jako odkazy.
- **Alternativní text:** převezme `alt` ze zdroje; když chybí, odvodí ho z názvu souboru nebo z titulku článku
  (redakce ho může upřesnit).
- **Stránky:** strom max. 2 úrovně (hlubší stránky se připojí pod nejvyššího předka).
- **Menu:** položky menu, které vedou na stránku, se zařadí do menu; položka s podnabídkou se stane
  **rozcestníkem** (stránka s dlaždicemi podstránek); položky na seznamy/kategorie a cizí weby se stanou odkazy
  v menu. Stránky, které v menu nebyly, zůstanou dostupné, ale mimo menu.
- **Úřední deska:** od nejstaršího dokumentu; kategorie podle názvu a kategorií zdroje (vyhlášky, zastupitelstvo,
  záměry, rozpočet, jiné úřady, veřejné vyhlášky, ostatní); datum sejmutí ze zdroje, jinak podle výchozí lhůty
  kategorie (min. 15 dní); u rozpočtu se z názvu odhadne druh a rok, takže novější dokument sám sejme starší.
- **Přesměrování:** každá stará adresa (stránka, článek, dokument, stránka kategorie) → nová, 301. Statistika
  použití je v administraci (Obecní web → Přesměrování).

## Adaptéry

| Adaptér        | Stav                                     | Zdroj dat                                                                               |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `wordpress`    | hotovo, ostrý pilot Vlastibořice         | REST API `/wp-json/wp/v2` (stránky, příspěvky, kategorie) + menu z HTML                 |
| `galileo`      | hotovo, read-only zkouška na jednom webu | HTML (menu `#menu`, `.gcm-main`, seznam aktualit `?page=all`, úřední deska `?show=0/1`) |
| `archiv`       | hotovo, pilot Vlastibořice (2002–2012)   | starý web z Wayback Machine (CDX + snímky `id_`), jen aktuality — viz níže              |
| `vismo`        | návrh                                    | HTML                                                                                    |
| `antee`        | návrh                                    | HTML                                                                                    |
| `e-obec` (SPH) | návrh                                    | HTML                                                                                    |

Podíl CMS u obcí (vlastní měření 10/2026, `docs/pruzkum/CMS-OBCI-2026-10.md`): Galileo ~37–39 %, vismo ~13–18 %,
Antee ~10–14 %, e-obec ~9–14 %, WordPress 1–4 %. Proto má Galileo přednost před dalšími.

## Archiv starého webu (Wayback Machine)

Starší weby obce, které už neběží (statické stránky, PHP systémy 2000–2015), bývají ve Wayback Machine. Adaptér
`archiv` (`archiv.ts` + `wayback.ts`) z nich vytáhne **jen aktuality** s původním datem zveřejnění:

1. seznam zachycených HTML stránek z CDX API (`--cdx soubor` nebo dotaz podle adresy; `--vsechny-snimky` vezme
   každou změněnou verzi stránky — titulní strana se v čase měnila a nese různé zprávy),
2. stránky se stahují jako „syrové“ snímky `…/web/<čas>id_/<url>` (bez lišty archivu), kódování windows-1250 /
   iso-8859-2 se pozná z `<meta>` nebo podle neplatného UTF-8,
3. **vytěžovače** (`VYTEZOVACE` v `archiv.ts`) z HTML vytáhnou články: `topdesign-aktuality` (Vložil: … | 27.04.2011),
   `topdesign-clanky` (rubriky `clanky_list` + detail `clanky_view`), `topdesign-staticke` (statické novinky
   s odrážkou, datum na začátku zprávy nebo „Poslední aktualizace“ stránky = odvozené). Nový typ starého webu =
   nový vytěžovač: funkce `clanky(html, url)` → `[{titulek, html, datum, detailUrl?, id?}]`,
4. stejné články z více stránek a snímků se sloučí (id článku, titulek + datum, nebo stejný den + začátek textu),
5. importér je založí v kategorii (`--kategorie "Archiv starého webu"`, založí se sama), **bez přesměrování**
   (staré adresy nepatří nové doméně), odkazy na neimportované stránky a nearchivované soubory nechá jen jako text,
   soubory, které archiv má, stáhne přes Wayback do `/soubory`, a **přeskočí duplicity** (podobný titulek a datum
   ±3 dny proti aktualitám na webu i proti `--zname` = seznamu článků z jiného zdroje, např. dnešního WordPressu).

```bash
# nanečisto (nic nezapíše) — výpis článků, duplicit a článků bez data k ručnímu posouzení
node dist/scripts/import.js archiv http://www.obec.cz/ --do 2013 --vsechny-snimky --cache /data/tmp/wayback \
  --kategorie "Archiv starého webu" --zname wp-clanky.tsv --nanecisto --s-html
# ostře: + ruční titulky a vynechané články (osobní údaje), zprávy o změnách starého webu pryč
node dist/scripts/import.js archiv http://www.obec.cz/ --do 2013 --vsechny-snimky --cache /data/tmp/wayback \
  --kategorie "Archiv starého webu" --zname wp-clanky.tsv --titulky titulky.tsv --vynechat vynechat.txt \
  --vynechat-text '(byl[ay]? přidán|vznikla nová rubrika)' --rozestup-ms 1500
```

Zásady a poučení (pilot Vlastibořice 10/2026):

- **Archive.org je pomalý a při souběžných dotazech vrací „Temporarily unavailable“** (i uprostřed výpisu CDX —
  `parsujCdx` takové řádky zahodí). Stahovat sekvenčně s rozestupem ≥ 1 s a s keší (`--cache`), nanečisto pustit
  dřív než ostře — druhý běh jde celý z keše.
- **Datum = datum zveřejnění z obsahu**, ne čas snímku. Zprávy bez data se neimportují a vypíšou se; odvozené datum
  (jen měsíc, datum aktualizace stránky) se vypíše ve výstupu nanečisto (`odvozene`).
- **Před importem porovnat s dnešním webem obce:** obsah starých webů bývá do novějšího systému už převedený
  (ve Vlastibořicích byl obsah 2007–2012 už ve WordPressu) — seznam `titulek<TAB>RRRR-MM-DD` předat jako `--zname`.
- Úřední desku, fotogalerie (fotky archiv většinou nemá), ankety a stálé stránky adaptér neimportuje.
- **GDPR:** výstup nanečisto s `--s-html` projít ručně (jména, adresy, děti na fotkách) a sporné články dát do
  `--vynechat`. Jméno „Vložil: …“ se nepřebírá.
- Import vrátit (do koše, obnovitelné v administraci):
  `UPDATE web_obsah SET smazano_at = now() WHERE typ = 'aktualita' AND zdroj = 'import' AND kategorie_id =
(SELECT id FROM web_kategorie WHERE slug = 'archiv-stareho-webu');` — soubory stažené z archivu mají v tabulce
  `soubory` vyplněné `zdroj_url` s adresou starého webu.

## Jak napsat nový adaptér

Implementujte rozhraní `ImportniZdroj` (`src/moduly/web/import/typy.ts`) — jen čtení:

```ts
export class VismoZdroj implements ImportniZdroj {
  readonly nazev = 'vismo';
  constructor(private v: { zaklad: string; stahovac: Stahovac }) {}
  async *stranky() {
    /* yield { klic, url, titulek, html, rodic?, poradi? } */
  }
  async *aktuality(od: Date) {
    /* yield { url, titulek, html, perex?, datum, obrazekUrl? } */
  }
  async *deska(od?: Date) {
    /* yield { url, nazev, html, vyvesenoOd, sejmutoDo?, kategorie } */
  }
  async menu() {
    /* parsujMenu(html, /třída/, zaklad) */
  }
  async presmerovani() {
    /* stránky seznamů → /aktuality, /uredni-deska */
  }
}
```

- Stahujte **jen přes `Stahovac`** (zdvořilé tempo, User-Agent s kontaktem, limit velikosti, v testech se podstrčí).
- HTML vracejte „syrové“ (absolutní nebo relativní odkazy) — přepis a sanitizaci udělá importér.
- Pomůcky: `parsujMenu()` (vnořené `<ul>/<li>`), `textTagu()`, `dekodujEntity()` (`html-pomoc.ts`), `vnitrekDivu()`,
  `ceskeDatum()` (`galileo.ts`), `kategorieDesky()` (`wordpress.ts`), `odhadniRozpocet()` (`importer.ts`).
- Test: falešný `Stahovac` s uloženými kousky HTML (vzor v `test/import.test.ts`, blok „adaptér Galileo“).
- Registrace: větev v `src/scripts/import.ts`.

**Poznámky k proprietárním CMS (orientační, neověřeno — před implementací ověřit na konkrétním webu):** vismo (Webhouse) má sekce `/obec/…` s parametry `?id=`, úřední desku
s vlastním modulem a přílohami `/assets/File.ashx?id_org=…`; Antee má cesty `/obec/…`, úřední desku v modulu
„Úřední deska“ s tabulkou (vyvěšeno/sejmuto); e-obec (SPH) má `/obec/…`, desku `/urad/uredni-deska/`.
Všechny vydávají HTML bez API → stejný princip jako Galileo (menu → stránky; seznam desky → detail → přílohy).
Před prvním použitím na webu obce: domluvit se s obcí, stahovat pomalu a mimo špičku.

## Poučení z pilotu Vlastibořice (úklid po importu, 19. 10. 2026)

Co import WordPressu udělal špatně a jak to příště ošetřit (dokud to importér neumí sám, udělat ručně po importu):

- **Dva stromy stránek.** Položka menu s podnabídkou vytvoří rozcestník (`menu:Obec`), jenže stejnojmenná
  rodičovská stránka WordPressu (`/obec/`) už slug `obec` zabrala → rozcestník dostal `obec-2` a podstránky zůstaly
  pod starou prázdnou stránkou mimo menu. Správně: prázdnou rodičovskou stránku zdroje použít jako rozcestník
  (nebo ji po importu dát do koše, rozcestníku vrátit čistý slug a podstránky přesunout pod něj).
- **Stránky se zamrzlým výpisem pluginu** (`[su_posts]` → „Články nenalezeny“, tabulky úřední desky) nemají
  na novém webu hodnotu → koncept + 301 na odpovídající modul (`/uredni-deska`, `/uredni-deska/archiv?kategorie=…`,
  `/rozpocet`, `/aktuality?kategorie=…`, `/povinne-informace`). Totéž stránky „informace se připravují“.
- **Přesměrování kategorií** vedla všechna na `/aktuality` → mapovat podle obsahu (zastupitelstvo, rozpočet,
  vyhlášky → deska/rozpočet; zpravodaj, kultura, sport → aktuality s kategorií; knihovna, osady → stránky).
- **Duplicitní právní texty** (kontakt, GDPR, prohlášení o přístupnosti, povinné informace) — údaje, které nativní
  stránka nemá, přenést: lidé, pověřenec a poznámky do `obec.yml`, body povinných informací do `pi_body`, volný
  text obce do stránky `kontakt-obec` / `ochrana-osobnich-udaju-obec` / `prohlaseni-o-pristupnosti-obec`
  (zobrazí se na nativní stránce, viz `src/moduly/web/doplnky.ts`); importované kopie do konceptu + 301.
- **Stránky pluginů a statické mapy stránek** (odkazy na cizí weby) do konceptu; mapa stránek je `/mapa-stranek`.
- **Soubor nad limit 30 MB** se nenahraje, odkaz v textu zůstane jako `/wp-content/…` (404). PDF zmenšit
  ghostscriptem (61 MB zpravodaj → 2,7 MB, čitelné):
  `docker run --rm -v in:/in:ro -v out:/out minidocks/ghostscript gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dColorImageResolution=150 -dNOPAUSE -dQUIET -dBATCH -sOutputFile=/out/x.pdf /in/x.pdf`
  a uložit přes `SouboroveUloziste.uloz({ …, zdrojUrl: <původní URL> })` — opakovaný import ho pak najde podle
  zdroje a odkaz přepíše sám.
- **Po úklidu menu už nespouštět import s částí `menu`** — postavil by menu znovu podle starého webu.
- Kontrola po úklidu: všechny interní odkazy v obsahu dotáhnout na konečnou adresu (bez řetězu 301) a ověřit HTTP stav.
