// Profil obce z obec.yml — validovaný přes zod, aby chybná konfigurace shodila start, ne až produkci.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const AdresaSchema = z.object({
  ulice: z.string().default(''),
  psc: z.string().default(''),
  mesto: z.string().default(''),
});

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
    // fakta do úvodu webu (statistiky): např. { hodnota: '357', popisek: 'obyvatel' }
    fakta: z.array(z.object({ hodnota: z.string().min(1), popisek: z.string().min(1) })).default([]),
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
        })
        .prefault({}),
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
