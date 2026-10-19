# Licence třetích stran (soubory vydávané návštěvníkům webu)

Platforma je pod EUPL-1.2. Do prohlížeče návštěvníků se navíc posílají tyto cizí soubory (vše self-hosted
z balíčků npm, žádné CDN):

| Součást               | Balíček                             | Licence                                                                           | Použití          |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------- | ---------------- |
| Ubuntu                | `@fontsource/ubuntu`                | Ubuntu Font Licence 1.0 (vložení do webu povoleno; úpravy písma pod jiným názvem) | písmo webu       |
| Atkinson Hyperlegible | `@fontsource/atkinson-hyperlegible` | SIL Open Font License 1.1                                                         | písmo webu       |
| Inter                 | `@fontsource/inter`                 | SIL OFL 1.1                                                                       | písmo webu       |
| Rubik                 | `@fontsource/rubik`                 | SIL OFL 1.1                                                                       | nadpisy          |
| Rubik Dirt            | `@fontsource/rubik-dirt`            | SIL OFL 1.1                                                                       | ozdobný titulek  |
| Source Sans 3         | `@fontsource/source-sans-3`         | SIL OFL 1.1                                                                       | písmo webu       |
| Merriweather          | `@fontsource/merriweather`          | SIL OFL 1.1                                                                       | nadpisy          |
| Nunito                | `@fontsource/nunito`                | SIL OFL 1.1                                                                       | písmo webu       |
| Genos                 | `@fontsource/genos`                 | SIL OFL 1.1                                                                       | písmo webu       |
| Quill 2               | `quill`                             | BSD-3-Clause                                                                      | editor ve správě |

Z písem se vydávají jen soubory `*.woff2` podmnožin latin a latin-ext (čeština ověřena na glyfech:
á č ď é ě í ň ó ř š ť ú ů ý ž, velká písmena, „ “ –). Texty licencí jsou v příslušných balíčcích
(`node_modules/@fontsource/*/LICENSE`).
