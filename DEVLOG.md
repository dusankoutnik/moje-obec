# Co je nového (devlog)

Přehled změn platformy Web od Voltu 2.0 pro pilotní obec, nejnovější nahoře. Technické podrobnosti jsou v CHANGELOG.md.

## 22. 10. 2026

- **Nový název:** platforma se jmenuje **Web od Voltu 2.0**, v patičce je logo Voltu s odkazem na Volt Česko.
- **Vzhled:** fotka obce v pozadí je víc vidět; texty přímo na fotce mají vlastní tmavý podklad, aby zůstaly čitelné.
- **Efekty tlačítek menu** ve Správě → Vzhled: decentní odlesk, vodní hladina, dýchání nebo bez efektu, a k tomu síla efektu. Kdo má v zařízení zapnuté „omezit pohyb“, vidí tlačítka vždy v klidu.
- **Odstávky elektřiny:** v kartě na titulce je i obrázkový banner ČEZ (stahuje ho náš server, návštěvník nic z cizího serveru nenačítá).
- **Staré odkazy fungují:** soubory starého webu (`/wp-content/uploads/…`) jsou dostupné na původních adresách; prohlížečům stálých návštěvníků se starý „offline“ režim sám odinstaluje.
- Odkaz **Správa** se přesunul z hlavičky do patičky.
- Tato stránka (devlog) v patičce testovacího webu.

## 21. 10. 2026

- **Kvíz pro občany:** 350 otázek v 9 oblastech se zdroji, místní otázky o Vlastibořicích, skóre u účtu nebo anonymně; správci vidí statistiky hráčů a mohou přidávat vlastní otázky.
- **Elektronická podatelna:** formulář pro podání bez elektronického podpisu, číslo podání, potvrzení podateli, evidence a vyřizování ve správě.
- **Odstávky elektřiny ČEZ** na titulce a na stránce `/odstavky` s historií za 30 dní.
- Obecně závazné vyhlášky (platné i historie) a formuláře ke stažení; na titulce nejbližší akce.

## 19. 10. 2026

- **Videa:** YouTube a Vimeo „na dva kliky“ (nic se nenačítá bez souhlasu), vlastní videa s titulky.
- **Aktuality ze starých webů obce** z let 2002–2009 (z internetového archivu) v kategorii „Archiv starého webu“.
- **Úklid importovaného webu:** jeden strom menu, přesměrování starých adres, mapa stránek, nativní kontakt, ochrana osobních údajů a prohlášení o přístupnosti.
- Opravy podle auditu souladu se zákony (povinné informace podle vyhlášky 515/2020 Sb., přístupnost, cookies) a podle bezpečnostní kontroly kódu (zámek přihlášení heslem, náhled „co se sejme“ na desce, přehled SMS ve správě).

## 18. 10. 2026

- **Úřední deska, rozpočet a povinně zveřejňované informace** jako součást platformy.
- **Obecní web:** stránky, aktuality, akce, galerie, dokumenty, dotace s logy, hledání, koncepty, náhled a historie změn.
- **Import ze starého webu:** obsah vlastiborice.cz převzat (stránky, aktuality, úřední deska, soubory).
- **Vzhled:** 9 barevných schémat s hlídáním kontrastu, výběr písem, velikost písma pro návštěvníky, střídání leteckých fotek obce v pozadí, favicon ze znaku.
- Akce sálu a hřišť z rezervačního systému v kalendáři akcí; citlivé změny účtu jen po novém ověření.
- Testovací web zpřístupněn veřejně k ukázce.

## 15. 10. 2026

- Ochrana přihlašování kódem: limity pokusů, neutrální odpovědi (nejde zjistit, kdo je v evidenci).

## 13. 10. 2026 — začátek

- Kostra otevřené platformy pro obce (licence EUPL-1.2): účty s přihlášením telefonem a SMS kódem, standardní jednotné přihlášení (OpenID Connect), infokanál pro SMS a e-mailová hlášení s adaptéry SMS bran, testy a dokumentace. Testovací web dev.vlastiborice.cz.
