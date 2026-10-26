// Profil obce z obec.yml — validovaný přes zod, aby chybná konfigurace shodila start, ne až produkci.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const AdresaSchema = z.object({
  ulice: z.string().default(''),
  psc: z.string().default(''),
  mesto: z.string().default(''),
});

// odkaz z dlaždice statistik: vlastní cesta (/…, ne //…) nebo https://
const ODKAZ_FAKTA = /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/;

/** zdroj automatických výstrah: chybí = vypnutý; prázdný klíč v YAML („cez:“) = zapnutý s výchozím nastavením */
function zdrojVystrah<T extends z.ZodType>(s: T) {
  return z.preprocess((v) => (v === null ? {} : v), s.optional());
}

export const ObecSchema = z.object({
  obec: z.object({
    nazev: z.string().min(1),
    kratky_nazev: z.string().min(1),
    ico: z.string().default(''),
    dic: z.string().default(''),
    adresa: AdresaSchema.prefault({}),
    kontakt: z
      .object({
        telefon: z.string().default(''),
        email: z.string().default(''),
        web: z.string().default(''),
        datova_schranka: z.string().default(''),
        epodatelna: z.string().default(''),
        fax: z.string().default(''),
        // víceřádkový text, např. „Po 8–12, 13–17\nSt 8–12, 13–18“
        uredni_hodiny: z.string().default(''),
      })
      .prefault({}),
    bankovni_ucet: z.object({ cislo: z.string().default(''), iban: z.string().default('') }).prefault({}),
    casti: z.array(z.string().min(1)).min(1),
    // povinně zveřejňované informace (vyhl. 515/2020 Sb.): nadřízený orgán (bod 2), plátce DPH (bod 7; neuvedeno =
    // úřad doplní), adresa obce ve Sbírce právních předpisů (bod 11.2; prázdné = odvodí se z datové schránky)
    nadrizeny_organ: z.string().default(''),
    platce_dph: z.boolean().optional(),
    sbirka_pp: z.string().default(''),
    kod_obce: z.string().default(''),
    orp_cisorp: z.string().default(''),
    poverenec: z
      .object({
        jmeno: z.string().default(''),
        email: z.string().default(''),
        telefon: z.string().default(''),
        adresa: z.string().default(''), // poštovní adresa pověřence (jeden řádek)
      })
      .prefault({}),
    // zpracovatelé osobních údajů (GDPR čl. 28) pro stránku Ochrana osobních údajů, např.
    // { nazev: 'Contabo GmbH (Německo)', ucel: 'pronájem serveru, na kterém web běží' }
    zpracovatele: z.array(z.object({ nazev: z.string().min(1), ucel: z.string().default('') })).default([]),
    // fakta do úvodu webu (statistiky): např. { hodnota: '357', popisek: 'obyvatel', odkaz: '/obec' } — odkaz
    // nepovinný (vlastní cesta /… nebo https://…), celá dlaždice pak vede na něj
    fakta: z
      .array(
        z.object({
          hodnota: z.string().min(1),
          popisek: z.string().min(1),
          odkaz: z
            .string()
            .regex(ODKAZ_FAKTA, 'odkaz musí být cesta na webu (/…) nebo začínat https://')
            .optional(),
        }),
      )
      .default([]),
    // zastupitelstvo: volební období a poznámka (např. termín ustavujícího zasedání) — u seznamu lidí na stránce
    // kontaktů a v bodě 3 povinných informací; prázdné = nezobrazí se
    zastupitelstvo: z
      .object({
        volebni_obdobi: z.string().default(''), // např. „2026–2030“
        poznamka: z.string().default(''),
      })
      .prefault({}),
    // obecní úřad a zastupitelstvo — organizační struktura (povinné informace bod 3) a stránka kontaktů
    lide: z
      .array(
        z.object({
          funkce: z.string().min(1),
          jmeno: z.string().min(1),
          telefon: z.string().default(''),
          email: z.string().default(''),
          skupina: z.string().default('Obecní úřad'),
          // krátká doplňující informace na stránce kontaktů (např. „Půjčovní doba: středa 16–18“)
          poznamka: z.string().default(''),
        }),
      )
      .default([]),
  }),
  // vzhled webu — správa ho může přepsat v administraci (nahrání znaku a fotky)
  vzhled: z
    .object({
      barva: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#1b5e20'),
      znak: z.string().default(''), // URL obrázku znaku/loga obce (např. /soubory/…)
      uvodni_foto: z.string().default(''),
      motto: z.string().default(''),
      // výchozí barevné schéma (id ze src/moduly/web/schemata.ts, nebo 'vlastni' = barva výše), písmo a velikost
      schema: z.string().default('vlastni'),
      pismo: z.string().default('ubuntu'),
      velikost: z.enum(['normalni', 'velke', 'extra']).default('normalni'),
    })
    .prefault({}),
  moduly: z
    .object({
      ucty: z.boolean().default(true),
      infokanal: z.boolean().default(true),
      deska: z.boolean().default(false),
      rezervace: z.boolean().default(false),
      knihovna: z.boolean().default(false),
      web: z.boolean().default(false),
      kviz: z.boolean().default(false),
      podatelna: z.boolean().default(false),
      // plánované odstávky elektřiny ČEZ Distribuce na titulce a /odstavky (jen obce na území ČEZ Distribuce)
      odstavky: z.boolean().default(false),
      // předpověď počasí MET Norway (yr.no) na titulce a /pocasi; potřebuje souřadnice v sekci pocasi
      pocasi: z.boolean().default(false),
      // části rezervačního systému (aplikace za proxy /rezervace): předprodej vstupenek a spolujízda
      predprodej: z.boolean().default(true),
      spolujizda: z.boolean().default(true),
      // knihovna e-knih (aplikace za proxy /eknihy); starší klíč `knihovna` se bere jako totéž
      eknihy: z.boolean().default(false),
    })
    .prefault({}),
  // obecní web (modul web)
  web: z
    .object({
      // veřejné termíny z rezervačního systému zakládat jako koncepty akcí ke zpracování (Akce ke zpracování)
      akce_koncepty: z.boolean().default(true),
      // statistika „zpráv za poslední měsíc“ v úvodu: slug kategorie aktualit; prázdné = všechny aktuality
      stat_zpravy_kategorie: z.string().default(''),
      // další rychlé dlaždice pod úvodem (za výchozími), např. knihovna
      rychle_odkazy: z
        .array(
          z.object({
            nazev: z.string().min(1).max(40),
            odkaz: z.string().regex(/^(\/(?![/\\])|https:\/\/)/),
            ikona: z.string().max(8).default('🔗'),
          }),
        )
        .max(4)
        .default([]),
    })
    .prefault({}),
  // elektronická podatelna — formulář pro podání bez elektronického podpisu (modul podatelna)
  podatelna: z
    .object({
      // kam se podání posílá e-mailem; prázdné = obec.kontakt.epodatelna, jinak obec.kontakt.email
      email: z.string().default(''),
      // doba uchování podání v aplikaci (roky) podle spisového a skartačního plánu obce; nic se nemaže samo
      uchovani_let: z.number().int().min(1).max(100).default(5),
    })
    .prefault({}),
  // plánované odstávky elektřiny (modul odstavky) — jen ČEZ Distribuce; obce v území EG.D nebo PREdistribuce
  // modul nezapínají (tito distributoři nemají obdobné API)
  odstavky: z
    .object({
      cez: z
        .object({
          // kód obce RÚIAN/ČSÚ; prázdné = obec.kod_obce
          kod_obce: z.string().regex(/^\d*$/, 'kód obce jsou jen číslice').default(''),
          // stránka ČEZ Distribuce pro obec (odkaz „redirect“ z banneru ČEZ pro obce); prázdné = obecná stránka ČEZ
          odkaz: z
            .string()
            .regex(/^(https:\/\/\S+)?$/, 'odkaz musí začínat https://')
            .default(''),
          // obrázkový banner ČEZ pro obce (…/v1/<klíč>/b/250); server ho stáhne a podá z /odstavky/banner.png,
          // prohlížeč návštěvníka nic od ČEZ nenačítá. Prázdné = jen textová karta.
          banner: z
            .string()
            .regex(/^(https:\/\/\S+)?$/, 'banner musí začínat https://')
            .default(''),
        })
        .prefault({}),
    })
    .prefault({}),
  // předpověď počasí (modul pocasi) — MET Norway Locationforecast, stahuje server nejvýš jednou za 30 min
  pocasi: z
    .object({
      // souřadnice obce (WGS84, stupně); do API se posílají zaokrouhlené na 4 desetinná místa
      lat: z.number().min(-90).max(90).nullable().default(null),
      lon: z.number().min(-180).max(180).nullable().default(null),
      // název místa v nadpisu („Počasí ve Vlastibořicích“); prázdné = obec.kratky_nazev
      nazev: z.string().default(''),
      // nadmořská výška obce v m (drobný údaj v dlaždici); prázdné = výška bodu předpovědi z MET
      vyska: z.number().int().min(-500).max(9000).nullable().default(null),
    })
    .prefault({}),
  texty: z
    .object({
      nazev_infokanalu: z.string().default('Infokanál'),
      sms_prefix: z.string().default(''),
    })
    .prefault({}),
  // prohlášení o přístupnosti (zák. 99/2019 Sb., § 8) — stav souladu a data posouzení vyplňuje obec, nedopočítávají se
  pristupnost: z
    .object({
      // plne = plně v souladu, castecne = částečně (výchozí — dokumenty a obsah z importu se neověřují), ne = není
      stav: z.enum(['plne', 'castecne', 'ne']).default('castecne'),
      vypracovano: z.string().default(''), // datum vypracování prohlášení YYYY-MM-DD
      aktualizovano: z.string().default(''), // datum poslední revize YYYY-MM-DD
      // jak se posuzovalo: vlastní posouzení / posouzení třetí stranou (název)
      posouzeni: z.string().default('vlastním posouzením provedeným obcí'),
    })
    .prefault({}),
  patika: z
    .object({
      prohlaseni_o_pristupnosti: z.string().default('/prohlaseni-o-pristupnosti'),
      ochrana_osobnich_udaju: z.string().default('/ochrana-osobnich-udaju'),
      kontakt: z.string().default('/kontakt'),
      // nepovinné: stránka se zásadami cookies (prázdné = odkaz se v patičce nezobrazí)
      zasady_cookies: z.string().default(''),
    })
    .prefault({}),
  // automatické výstrahy infokanálu; zdroj, který v profilu chybí, je vypnutý (vypínač pro celé: env VYSTRAHY=0)
  vystrahy: z
    .object({
      // výstrahy ČHMÚ (CAP) pro obvod obce s rozšířenou působností; orp prázdné = obec.orp_cisorp
      chmu: zdrojVystrah(
        z.object({
          orp: z.string().regex(/^\d*$/, 'kód ORP jsou jen číslice').default(''),
          // jak se oblast jmenuje v textu e-mailu („Turnovsko“); prázdné = „ORP <kód>“
          oblast: z.string().default(''),
        }),
      ),
      // plánované odstávky elektřiny ČEZ (stejná data jako modul odstavky); kod_obce prázdné = odstavky/obec
      cez: zdrojVystrah(
        z.object({ kod_obce: z.string().regex(/^\d*$/, 'kód obce jsou jen číslice').default('') }),
      ),
      // výpadky vody SčVK (plánované odstávky a havárie); obec = název obce, jak ho píše scvk.cz
      scvk: zdrojVystrah(z.object({ obec: z.string().default('') })),
    })
    .prefault({}),
});

export type ObecProfil = z.infer<typeof ObecSchema>;

export function nactiObec(cesta: string): ObecProfil {
  const raw = parse(readFileSync(cesta, 'utf8'));
  const vysledek = ObecSchema.safeParse(raw);
  if (!vysledek.success) {
    const chyby = vysledek.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Profil obce ${cesta} je neplatný: ${chyby}`);
  }
  return vysledek.data;
}

export function obecZObjektu(raw: unknown): ObecProfil {
  return ObecSchema.parse(raw);
}
