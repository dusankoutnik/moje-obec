# Kvíz — banka otázek

Otázky pro kvízový modul platformy (obdoba hospodských kvízů). Každá kategorie má vlastní soubor `<slug>.yaml`.

## Veřejný balík (tento adresář)

| Soubor             | Kategorie                                                                   | Otázek |
| ------------------ | --------------------------------------------------------------------------- | ------ |
| `cr.yaml`          | Česká republika (zeměpis, symboly, a také obec, volby, úřady, práva občana) | 70     |
| `eu.yaml`          | Evropská unie                                                               | 35     |
| `svet.yaml`        | Svět                                                                        | 40     |
| `vesmir-veda.yaml` | Vesmír a věda                                                               | 40     |
| `cestina.yaml`     | Čeština                                                                     | 40     |
| `priroda.yaml`     | Příroda (ČR i svět)                                                         | 30     |
| `dejiny.yaml`      | Dějiny (české i světové)                                                    | 35     |
| `sport.yaml`       | Sport (český i světový)                                                     | 30     |
| `kultura.yaml`     | Kultura (literatura, hudba, film, výtvarné umění, divadlo, architektura)    | 30     |

## Formát

```yaml
kategorie: cr # slug = název souboru bez .yaml
nazev: Česká republika
ikona: '🇨🇿'
otazky:
  - id: cr-001 # stabilní a unikátní napříč všemi balíky: <slug>-NNN
    otazka: 'Které město je hlavním městem Moravskoslezského kraje?'
    odpovedi: ['Ostrava', 'Opava', 'Frýdek-Místek', 'Karviná']
    obtiznost: 1
    vysvetleni: 'Krátká zajímavost (1–2 věty), zobrazí se po odpovědi.'
    zdroj: 'https://…'
```

- `odpovedi` — **vždy 4 různé**, **první je správná**; aplikace pořadí zamíchá.
- `obtiznost` — 1 ví skoro každý · 2 lehká · 3 ví zhruba polovina · 4 těžká · 5 ví znalec.
  Doporučené rozložení v kategorii: 1 → 20 %, 2 → 25 %, 3 → 25 %, 4 → 20 %, 5 → 10 %.
- `zdroj` — URL otevřené stránky, na které je fakt ověřitelný.
- Kódování UTF-8; řetězce v dvojitých uvozovkách, uvnitř textu české uvozovky „…“.
- `id` se po zveřejnění nemění (aplikace podle něj může vést statistiky). Otázka odebraná z balíku se v aplikaci jen vyřadí (historie odpovědí zůstává); její id se znovu nepoužije.

## Vlastní balík obce

Místní otázky (obec, region, okres, kraj) nepatří do veřejného repozitáře — patří k instalaci obce.

1. Vytvořte adresář mimo repozitář platformy, např. `platforma-instance/kviz/` (cestu určuje konfigurace instalace).
2. Pro každou kategorii jeden soubor ve stejném formátu, s vlastním slugem, který nekoliduje s veřejnými (např. `obec`, `region`, `okres`, `kraj`).
3. Id pište s prefixem slugu (`obec-001`…), ať jsou unikátní i vedle veřejného balíku.
4. Ověřte strukturu, např.:
   ```sh
   python3 -c "import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); assert all(len(set(q['odpovedi']))==4 for q in d['otazky']); print(d['kategorie'], len(d['otazky']))" obec.yaml
   ```

## Zásady kvality

- **Každý fakt ověřený na otevřené stránce** (Wikipedie, ČSÚ, RÚIAN, weby obcí a krajů, AOPK, Internetová jazyková příručka ÚJČ, NASA/ESA, europa.eu, zakonyprolidi.cz). Co nejde ověřit, do banky nepatří.
- **Jednoznačná správná odpověď**, žádné chytáky. Distraktory věrohodné (stejný typ, podobná délka), ale jednoznačně špatné — u pravopisu nesmí být žádný distraktor přípustnou dubletou.
- **Nadčasovost:** žádní aktuální funkcionáři, žádné „současné rekordy“, počty obyvatel jen jako rozmezí s uvedeným rokem.
- **Nestrannost:** žádné hodnocení politických stran ani politiků.
- **Soukromí:** žádné osobní údaje žijících soukromých osob.
- Vysvětlení přidává zajímavost, neopakuje otázku.
- Před vydáním kontrolní průchod: znovu ověřit náhodný vzorek a všechny otázky obtížnosti 4–5 (místní balík celý), hledat duplicity a ověřit, že první odpověď je správná a žádný distraktor není také správný.
- Chybu v otázce nahlaste nebo opravte pull requestem s odkazem na zdroj.

Licence: obsah je součástí platformy pod EUPL-1.2.
