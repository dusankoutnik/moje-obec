// Import balíků otázek kvízu z YAML do databáze — idempotentní podle id otázky.
// Veřejné balíky leží v repozitáři (kviz-otazky/*.yml), balíky konkrétní obce mimo repozitář (KVIZ_BALIKY).
// Změny textu se propíší, otázky, které z balíku zmizely, se jen označí v_baliku = false (historie odpovědí zůstává).
// Soubor s chybou se přeskočí celý a jeho otázky se NEdeaktivují (překlep nesmí vyřadit polovinu banky).
// Otázky přidané ručně ve správě (rucne = true) import nikdy nevyřadí ani nepřepíše; otázka z balíku se stejným id
// se přeskočí a vypíše jako kolize.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Db } from '../../db/index.js';

/** pevné pořadí kategorií (ostatní za nimi podle názvu) */
export const PORADI_KATEGORII = [
  'obec',
  'region',
  'okres',
  'kraj',
  'cr',
  'eu',
  'svet',
  'priroda',
  'dejiny',
  'vesmir-veda',
  'cestina',
  'kultura',
  'sport',
] as const;

const text = (max: number) => z.string().trim().max(max);
const odpoved = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1, 'prázdná odpověď').max(300));

export const OtazkaSchema = z.object({
  id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9._-]{1,64}$/, 'id smí obsahovat jen písmena bez diakritiky, číslice, . _ -'),
    ),
  otazka: text(600).min(3, 'otázka je příliš krátká'),
  odpovedi: z
    .array(odpoved)
    .length(4, 'otázka musí mít právě 4 odpovědi (první je správná)')
    // přesná shoda — otázky na pravopis se smí lišit jen velikostí písmen („Pod Kaštany“ × „Pod kaštany“)
    .refine((o) => new Set(o).size === o.length, 'odpovědi se opakují'),
  obtiznost: z.number().int().min(1, 'obtížnost 1–5').max(5, 'obtížnost 1–5'),
  vysvetleni: text(2000).default(''),
  zdroj: text(500).default(''),
});

export const BalikSchema = z.object({
  kategorie: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/, 'kategorie = krátký identifikátor (malá písmena, číslice, -)'),
  nazev: text(100).min(1),
  ikona: text(16).default(''),
  otazky: z.array(OtazkaSchema).min(1, 'balík nemá žádné otázky'),
});
export type Balik = z.infer<typeof BalikSchema>;

export interface VysledekImportu {
  soubory: number;
  kategorie: number;
  otazky: number;
  nove: number;
  zmenene: number;
  deaktivovane: number;
  chyby: { soubor: string; zprava: string }[];
  /** otázky z balíků přeskočené proto, že stejné id má ručně přidaná otázka */
  kolize: { soubor: string; id: string }[];
}

export function poradiKategorie(slug: string): number {
  const i = (PORADI_KATEGORII as readonly string[]).indexOf(slug);
  return i >= 0 ? (i + 1) * 10 : 1000;
}

/** přečte a ověří jeden soubor; vrací balík nebo chybu (čitelnou pro člověka, s cestou k poli) */
export function overBalik(obsah: string): { balik: Balik } | { chyba: string } {
  let data: unknown;
  try {
    data = parse(obsah);
  } catch (e) {
    return { chyba: `neplatný YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = BalikSchema.safeParse(data);
  if (!r.success) {
    const chyby = r.error.issues.slice(0, 5).map((i) => {
      const cesta = i.path.length ? i.path.join('.') : '(kořen)';
      return `${cesta}: ${i.message}`;
    });
    return {
      chyba: chyby.join('; ') + (r.error.issues.length > 5 ? ` (+${r.error.issues.length - 5} dalších)` : ''),
    };
  }
  return { balik: r.data };
}

async function souboryVAdresari(adresar: string): Promise<string[]> {
  const polozky = await fs.readdir(adresar, { withFileTypes: true }).catch(() => []);
  return polozky
    .filter((p) => p.isFile() && /\.ya?ml$/i.test(p.name))
    .map((p) => path.join(adresar, p.name))
    .sort();
}

/**
 * Načte všechny balíky z adresářů a uloží je do DB. `adresare` = [{ cesta, stitek }] — štítek je předpona názvu
 * balíku v DB (např. „verejne/cr.yml“, „obec/obec.yml“), aby se rozlišily stejně pojmenované soubory.
 */
export async function importujBaliky(
  db: Db,
  adresare: { cesta: string; stitek: string }[],
): Promise<VysledekImportu> {
  const vysledek: VysledekImportu = {
    soubory: 0,
    kategorie: 0,
    otazky: 0,
    nove: 0,
    zmenene: 0,
    deaktivovane: 0,
    chyby: [],
    kolize: [],
  };
  const nactene: { balik: Balik; nazev: string }[] = [];
  const chybne = new Set<string>();
  const videnaId = new Map<string, string>();
  for (const a of adresare) {
    for (const soubor of await souboryVAdresari(a.cesta)) {
      const nazev = `${a.stitek}/${path.basename(soubor)}`;
      const r = overBalik(await fs.readFile(soubor, 'utf8'));
      if ('chyba' in r) {
        vysledek.chyby.push({ soubor: nazev, zprava: r.chyba });
        chybne.add(nazev);
        continue;
      }
      // id musí být jedinečné napříč všemi balíky
      const duplicitni = r.balik.otazky.find((o) => videnaId.has(o.id));
      const vSouboru = new Set<string>();
      const dvakrat = r.balik.otazky.find((o) => (vSouboru.has(o.id) ? true : (vSouboru.add(o.id), false)));
      if (duplicitni || dvakrat) {
        const o = (duplicitni ?? dvakrat)!;
        vysledek.chyby.push({
          soubor: nazev,
          zprava: `id ${o.id} se opakuje${duplicitni ? ` (už je v ${videnaId.get(o.id)})` : ''}`,
        });
        chybne.add(nazev);
        continue;
      }
      for (const o of r.balik.otazky) videnaId.set(o.id, nazev);
      nactene.push({ balik: r.balik, nazev });
      vysledek.soubory++;
    }
  }

  await db.transaction().execute(async (trx) => {
    const kategorieId = new Map<string, number>();
    for (const { balik } of nactene) {
      if (kategorieId.has(balik.kategorie)) continue; // více souborů téže kategorie: název a ikona z prvního
      const k = await trx
        .insertInto('kviz_kategorie')
        .values({
          slug: balik.kategorie,
          nazev: balik.nazev,
          ikona: balik.ikona,
          poradi: poradiKategorie(balik.kategorie),
        })
        .onConflict((oc) =>
          oc.column('slug').doUpdateSet({
            nazev: balik.nazev,
            ikona: balik.ikona,
            poradi: poradiKategorie(balik.kategorie),
            aktualizovano_at: new Date(),
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      kategorieId.set(balik.kategorie, k.id);
    }
    vysledek.kategorie = kategorieId.size;

    const stare = new Map(
      (
        await trx
          .selectFrom('kviz_otazky')
          .select([
            'id',
            'kategorie_id',
            'otazka',
            'odpovedi',
            'obtiznost',
            'vysvetleni',
            'zdroj',
            'v_baliku',
            'rucne',
          ])
          .execute()
      ).map((o) => [o.id, o]),
    );
    for (const { balik, nazev } of nactene) {
      const katId = kategorieId.get(balik.kategorie)!;
      for (const o of balik.otazky) {
        const s = stare.get(o.id);
        if (s?.rucne) {
          vysledek.kolize.push({ soubor: nazev, id: o.id });
          continue;
        }
        vysledek.otazky++;
        const hodnoty = {
          kategorie_id: katId,
          otazka: o.otazka,
          odpovedi: o.odpovedi,
          obtiznost: o.obtiznost,
          vysvetleni: o.vysvetleni,
          zdroj: o.zdroj,
          balik: nazev,
          v_baliku: true,
        };
        if (!s) {
          await trx
            .insertInto('kviz_otazky')
            .values({ id: o.id, ...hodnoty })
            .execute();
          vysledek.nove++;
          continue;
        }
        const zmena =
          s.kategorie_id !== katId ||
          s.otazka !== o.otazka ||
          s.odpovedi.join('\u0000') !== o.odpovedi.join('\u0000') ||
          s.obtiznost !== o.obtiznost ||
          s.vysvetleni !== o.vysvetleni ||
          s.zdroj !== o.zdroj ||
          !s.v_baliku;
        if (zmena) {
          await trx
            .updateTable('kviz_otazky')
            .set({ ...hodnoty, aktualizovano_at: new Date() })
            .where('id', '=', o.id)
            .execute();
          vysledek.zmenene++;
        } else {
          await trx.updateTable('kviz_otazky').set({ balik: nazev }).where('id', '=', o.id).execute();
        }
      }
    }
    // otázky, které v žádném načteném balíku nejsou (a nepocházejí z chybného souboru) → mimo balík
    let deaktivace = trx
      .updateTable('kviz_otazky')
      .set({ v_baliku: false, aktualizovano_at: new Date() })
      .where('v_baliku', '=', true)
      .where('rucne', '=', false);
    if (videnaId.size) deaktivace = deaktivace.where('id', 'not in', [...videnaId.keys()]);
    if (chybne.size) deaktivace = deaktivace.where('balik', 'not in', [...chybne]);
    const r = await deaktivace.executeTakeFirst();
    vysledek.deaktivovane = Number(r.numUpdatedRows ?? 0);
  });
  return vysledek;
}
