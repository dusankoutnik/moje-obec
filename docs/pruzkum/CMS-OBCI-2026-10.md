# Redakční systémy obecních webů — vlastní měření (17. 10. 2026)

Nezávislá statistika neexistuje (jen tvrzení dodavatelů: Galileo „přes polovinu samospráv“, Webhouse/vismo
„přes 30 % měst“, Antee „přes 900 obcí“). Proto vlastní vzorek.

**Metoda:** Seznam OVM (czechpoint.cz, `service=seznamovm`) → 6 340 subjektů s právní formou 801 Obec.
Web se odvodil z e-mailové domény úřadu (3 632 obcí má e-mail na vlastní doméně; obce s e-mailem na seznam.cz apod.
ve vzorku chybí — vychýlení k větším a „digitálnějším“ obcím). Náhodný vzorek 500 (seed 42), staženo 471 titulních
stránek, systém určen podle podpisu v HTML (`cms-scan.py`).

| Systém | Podíl (n = 471) |
|---|---|
| Galileo (GCM) | 37,4 % |
| vismo (Webhouse) | 13,4 % |
| Antee | 10,4 % |
| e-obec (SPH) | 9,1 % |
| WordPress | 4,0 % |
| Webnode | 1,1 % |
| Joomla | 0,8 % |
| Drupal | 0,4 % |
| ostatní / neurčeno (dlouhý ocas: Public4u, WebJET, inPage, TYPO3, xart, Šumavanet, ruční HTML…) | 23,4 % |

**Závěr:** trh obecních webů = proprietární SaaS čtyř dodavatelů (~70 %), kteří prodávají web + úřední desku
jako jeden balík. WordPress ani Drupal mezi obcemi skoro nejsou. Otevřené alternativy: **CSGOV** (Drupal 11,
design systém gov.cz, github.com/Drupalcz/csgov) a šablona **WP Gov.cz** (WordPress). Odhad ±4 p. b. (95 %).

## Doplněk 18. 10. 2026: obce BEZ e-mailu na vlastní doméně (cílová skupina)

Adresy webů z Wikidat (`P7606` kód obce → `P856` oficiální web; 6 254 obcí), spárováno s obcemi ze Seznamu OVM,
které mají jen e-mail na freemailu (seznam.cz, email.cz…): 2 646 obcí. Náhodný vzorek 110 (seed 7), dostupných 106,
skript `cms-scan-url.py`.

| Systém | Podíl (n = 106) |
|---|---|
| Galileo (GCM) | 38,7 % |
| vismo (Webhouse) | 17,9 % |
| Antee | 14,2 % |
| e-obec (SPH) | 14,2 % |
| WordPress | 0,9 % |
| Joomla | 0,9 % |
| ostatní / neurčeno | 13,2 % |

**Závěr:** u menších obcí je trh ještě soustředěnější — čtyři dodavatelé ~85 %, WordPress prakticky nula.
Import ze starých webů tedy musí v první řadě umět **Galileo, vismo, Antee a e-obec** (HTML scraping), WordPress až potom
(stačí pro Vlastibořice). Odhad ±9 p. b. (95 %); Wikidata mohou mít u části obcí starou adresu.
