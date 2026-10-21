// Otázky přidané ručně ve správě kvízu (jen role spravce/admin). Ověřují se stejným schématem jako balíky YAML,
// ukládají se s rucne = true, balik = 'rucne' a id „<kategorie>-r<číslo>“; import YAML je nikdy nevyřadí ani
// nepřepíše. Jdou upravit, vypnout (jako ostatní otázky) a stáhnout jako YAML pro přenos do balíku.
import { sql } from 'kysely';
import { Document } from 'yaml';
import type { z } from 'zod';
import type { Db } from '../../db/index.js';
import type { Uzivatel } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { BalikSchema, OtazkaSchema, poradiKategorie } from './import.js';

export const BALIK_RUCNE = 'rucne';
export const NOVA_KATEGORIE = '__nova';
/** slugy, které by zakryly pevné adresy správy /sprava/kviz/<…> */
export const VYHRAZENE_SLUGY = ['hraci', 'nova', 'otazka', 'import', 'rucne'];

const RucniOtazkaSchema = OtazkaSchema.omit({ id: true });
const NovaKategorieSchema = BalikSchema.pick({ kategorie: true, nazev: true, ikona: true });
export type RucniOtazka = z.infer<typeof RucniOtazkaSchema>;

/** pole formuláře (vše řetězce, jak je pošle prohlížeč) */
export interface FormularOtazky {
  kategorie?: string;
  nova_slug?: string;
  nova_nazev?: string;
  nova_ikona?: string;
  otazka?: string;
  spravna?: string;
  spatna1?: string;
  spatna2?: string;
  spatna3?: string;
  obtiznost?: string;
  vysvetleni?: string;
  zdroj?: string;
}

const POPISKY: Record<string, string> = {
  otazka: 'Otázka',
  odpovedi: 'Odpovědi',
  obtiznost: 'Obtížnost',
  vysvetleni: 'Vysvětlení',
  zdroj: 'Zdroj',
  kategorie: 'Zkratka nové kategorie',
  nazev: 'Název nové kategorie',
  ikona: 'Ikona nové kategorie',
};
const ODPOVEDI = ['správná odpověď', '1. špatná odpověď', '2. špatná odpověď', '3. špatná odpověď'];

function zpravy(e: z.ZodError): string[] {
  return e.issues.map((i) => {
    const [pole, index] = i.path;
    const popisek =
      pole === 'odpovedi' && typeof index === 'number'
        ? ODPOVEDI[index]!
        : (POPISKY[String(pole)] ?? String(pole));
    return `${popisek}: ${i.message}`;
  });
}

export type VysledekFormulare =
  | {
      ok: true;
      otazka: RucniOtazka;
      kategorie: { slug: string } | { nova: { kategorie: string; nazev: string; ikona: string } };
    }
  | { ok: false; chyby: string[] };

/** ověří formulář (bez zápisu); existující kategorie se kontrolují proti DB */
export async function overFormular(db: Db, f: FormularOtazky): Promise<VysledekFormulare> {
  const chyby: string[] = [];
  const obtiznost = Number(f.obtiznost);
  const o = RucniOtazkaSchema.safeParse({
    otazka: f.otazka ?? '',
    odpovedi: [f.spravna, f.spatna1, f.spatna2, f.spatna3].map((x) => x ?? ''),
    obtiznost: Number.isFinite(obtiznost) ? obtiznost : 0,
    vysvetleni: f.vysvetleni ?? '',
    zdroj: f.zdroj ?? '',
  });
  if (!o.success) chyby.push(...zpravy(o.error));

  let kategorie: Extract<VysledekFormulare, { ok: true }>['kategorie'] | null = null;
  if (f.kategorie === NOVA_KATEGORIE) {
    const k = NovaKategorieSchema.safeParse({
      kategorie: (f.nova_slug ?? '').trim(),
      nazev: f.nova_nazev ?? '',
      ikona: f.nova_ikona ?? '',
    });
    if (!k.success) chyby.push(...zpravy(k.error));
    else if (VYHRAZENE_SLUGY.includes(k.data.kategorie))
      chyby.push(`Zkratka nové kategorie: „${k.data.kategorie}“ je vyhrazená, zvolte jinou`);
    else if (
      await db
        .selectFrom('kviz_kategorie')
        .select('id')
        .where('slug', '=', k.data.kategorie)
        .executeTakeFirst()
    )
      chyby.push(
        `Zkratka nové kategorie: kategorie „${k.data.kategorie}“ už existuje — vyberte ji ze seznamu`,
      );
    else kategorie = { nova: k.data };
  } else {
    const k = f.kategorie
      ? await db
          .selectFrom('kviz_kategorie')
          .select('slug')
          .where('slug', '=', f.kategorie)
          .executeTakeFirst()
      : undefined;
    if (!k) chyby.push('Kategorie: vyberte kategorii ze seznamu, nebo založte novou');
    else kategorie = { slug: k.slug };
  }
  if (chyby.length || !o.success || !kategorie) return { ok: false, chyby };
  return { ok: true, otazka: o.data, kategorie };
}

/** formulářová pole z uložené otázky (pro úpravu) */
export function formularZ(o: {
  kategorie: string;
  otazka: string;
  odpovedi: string[];
  obtiznost: number;
  vysvetleni: string;
  zdroj: string;
}): FormularOtazky {
  return {
    kategorie: o.kategorie,
    otazka: o.otazka,
    spravna: o.odpovedi[0],
    spatna1: o.odpovedi[1],
    spatna2: o.odpovedi[2],
    spatna3: o.odpovedi[3],
    obtiznost: String(o.obtiznost),
    vysvetleni: o.vysvetleni,
    zdroj: o.zdroj,
  };
}

async function idKategorie(
  trx: Db,
  k: Extract<VysledekFormulare, { ok: true }>['kategorie'],
  aktor: Uzivatel,
  ip: string | null | undefined,
) {
  if ('slug' in k) {
    const r = await trx
      .selectFrom('kviz_kategorie')
      .select(['id', 'slug'])
      .where('slug', '=', k.slug)
      .executeTakeFirstOrThrow();
    return r;
  }
  const r = await trx
    .insertInto('kviz_kategorie')
    .values({
      slug: k.nova.kategorie,
      nazev: k.nova.nazev,
      ikona: k.nova.ikona,
      poradi: poradiKategorie(k.nova.kategorie),
    })
    .returning(['id', 'slug'])
    .executeTakeFirstOrThrow();
  await zapisAudit(trx, {
    uzivatelId: aktor.id,
    akce: 'kviz.kategorie_pridana',
    detail: { kategorie: r.slug, nazev: k.nova.nazev },
    ip,
  });
  return r;
}

/** uloží novou ruční otázku; vrací její id */
export async function pridejOtazku(
  db: Db,
  v: Extract<VysledekFormulare, { ok: true }>,
  aktor: Uzivatel,
  ip?: string | null,
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    // čísla ručních otázek se přidělují postupně — souběžné uložení nesmí dostat stejné id
    await sql`SELECT pg_advisory_xact_lock(hashtext('kviz_rucne'))`.execute(trx);
    const k = await idKategorie(trx, v.kategorie, aktor, ip);
    const predpona = `${k.slug}-r`;
    const max = await sql<{ max: number | null }>`
      SELECT max(substring(id FROM ${'^' + k.slug + '-r([0-9]{1,9})$'})::int) AS max
        FROM kviz_otazky WHERE id LIKE ${predpona + '%'}`.execute(trx);
    const id = `${predpona}${(max.rows[0]?.max ?? 0) + 1}`;
    await trx
      .insertInto('kviz_otazky')
      .values({
        id,
        kategorie_id: k.id,
        ...v.otazka,
        balik: BALIK_RUCNE,
        v_baliku: true,
        rucne: true,
      })
      .execute();
    await zapisAudit(trx, {
      uzivatelId: aktor.id,
      akce: 'kviz.otazka_pridana',
      detail: { otazka: id, kategorie: k.slug },
      ip,
    });
    return id;
  });
}

/** ruční otázka pro úpravu (otázky z balíků se ve správě neupravují → null) */
export async function rucniOtazka(db: Db, id: string) {
  return db
    .selectFrom('kviz_otazky as o')
    .innerJoin('kviz_kategorie as k', 'k.id', 'o.kategorie_id')
    .select([
      'o.id',
      'o.otazka',
      'o.odpovedi',
      'o.obtiznost',
      'o.vysvetleni',
      'o.zdroj',
      'o.vypnuta_at',
      'k.slug as kategorie',
    ])
    .where('o.id', '=', id)
    .where('o.rucne', '=', true)
    .executeTakeFirst();
}

/** uloží úpravu ruční otázky; vrací slug kategorie (kam se vrátit) nebo null, když otázka není ruční */
export async function upravOtazku(
  db: Db,
  id: string,
  v: Extract<VysledekFormulare, { ok: true }>,
  aktor: Uzivatel,
  ip?: string | null,
): Promise<string | null> {
  return db.transaction().execute(async (trx) => {
    const puvodni = await trx
      .selectFrom('kviz_otazky')
      .select('id')
      .where('id', '=', id)
      .where('rucne', '=', true)
      .forUpdate()
      .executeTakeFirst();
    if (!puvodni) return null;
    const k = await idKategorie(trx, v.kategorie, aktor, ip);
    await trx
      .updateTable('kviz_otazky')
      .set({ kategorie_id: k.id, ...v.otazka, aktualizovano_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(trx, {
      uzivatelId: aktor.id,
      akce: 'kviz.otazka_upravena',
      detail: { otazka: id, kategorie: k.slug },
      ip,
    });
    return k.slug;
  });
}

/** ruční otázky kategorie jako balík YAML (pro přenos do balíku obce); null = kategorie nemá ruční otázky */
export async function exportYaml(db: Db, slug: string): Promise<string | null> {
  const k = await db.selectFrom('kviz_kategorie').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!k) return null;
  const otazky = await db
    .selectFrom('kviz_otazky')
    .select(['id', 'otazka', 'odpovedi', 'obtiznost', 'vysvetleni', 'zdroj'])
    .where('kategorie_id', '=', k.id)
    .where('rucne', '=', true)
    .where('vypnuta_at', 'is', null)
    .orderBy(sql`length(id)`)
    .orderBy('id')
    .execute();
  if (!otazky.length) return null;
  const doc = new Document({
    kategorie: k.slug,
    nazev: k.nazev,
    ikona: k.ikona,
    otazky: otazky.map((o) => ({
      id: o.id,
      otazka: o.otazka,
      odpovedi: o.odpovedi,
      obtiznost: o.obtiznost,
      vysvetleni: o.vysvetleni,
      zdroj: o.zdroj,
    })),
  });
  doc.commentBefore =
    ' Ruční otázky kvízu (stažené ze správy). Před vložením do balíku změňte id (tvar <kategorie>-r<číslo>\n' +
    ' patří ručním otázkám — balík se stejným id se přeskočí) a ruční otázky ve správě pak vypněte.';
  return doc.toString({ lineWidth: 0 });
}
