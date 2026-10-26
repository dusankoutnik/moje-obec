// Převod rubrik zdroje 1:1: strom rubrik aktualit (chybějící se založí, existující podle výjimek se jen napojí),
// zařazení článků (hlavní = nejkonkrétnější rubrika, ostatní jako další) a přesměrování stránek rubrik.
import { slugify } from '../../../../lib/slug.js';
import { sPodrubrikami } from '../../rubriky.js';
import type { ImportKontext } from '../kontext.js';
import type { ImportClanek } from '../typy.js';

export async function pripravRubriky(ctx: ImportKontext) {
  if (!ctx.zdroj.rubriky) throw new Error('zdroj neumí rubriky');
  const zdroj = await ctx.zdroj.rubriky();
  const vyjimky = ctx.v.kategorieAktualit ?? {};
  const db = ctx.s.db;
  const existujici = await db.selectFrom('web_kategorie').selectAll().execute();
  const podleSlugu = new Map(existujici.map((k) => [k.slug, k]));
  const mapa = new Map<string, number>();
  // 1) založit / napojit (stejný slug = stejná rubrika; jiný význam stejného slugu se řeší výjimkou)
  let poradi = 200;
  for (const r of zdroj) {
    const cil = vyjimky[r.slug] ?? slugify(r.slug, 40);
    let id = podleSlugu.get(cil)?.id;
    if (!id) {
      const n = await db
        .insertInto('web_kategorie')
        .values({ slug: cil, nazev: r.nazev.slice(0, 100), poradi: (poradi += 10) })
        .onConflict((oc) => oc.column('slug').doUpdateSet({ slug: cil }))
        .returningAll()
        .executeTakeFirstOrThrow();
      podleSlugu.set(cil, n);
      id = n.id;
      ctx.log(`rubrika založena: ${r.nazev} (${cil})`);
    }
    mapa.set(r.slug, id);
  }
  // 2) zanoření jako ve zdroji (jen u rubrik, které zatím nadřazenou nemají)
  for (const r of zdroj) {
    const id = mapa.get(r.slug)!;
    const rodic = r.rodic ? mapa.get(r.rodic) : undefined;
    if (!rodic || rodic === id) continue;
    const vse = await db.selectFrom('web_kategorie').selectAll().execute();
    if (sPodrubrikami(vse, id).includes(rodic)) continue; // cyklus
    await db
      .updateTable('web_kategorie')
      .set({ nadrazena_id: rodic })
      .where('id', '=', id)
      .where('nadrazena_id', 'is', null)
      .execute();
  }
  ctx.rubriky = mapa;
}

/** hlavní a další rubrika článku podle převodu 1:1 */
export function rubrikyClanku(
  ctx: ImportKontext,
  a: ImportClanek,
): { hlavni: number | null; dalsi: number[] } {
  const ids = [
    ...new Set((a.kategorieVse ?? []).map((s) => ctx.rubriky!.get(s)).filter((x) => x !== undefined)),
  ];
  return { hlavni: ids[0] ?? null, dalsi: ids.slice(1) };
}

/** už importovaný článek přeřadit; ručně upravený (upravil_id) jen doplnit o chybějící další rubriky */
export async function prerazClanek(ctx: ImportKontext, id: string, a: ImportClanek) {
  const { hlavni, dalsi } = rubrikyClanku(ctx, a);
  if (hlavni === null) return;
  const o = await ctx.s.db
    .selectFrom('web_obsah')
    .select(['kategorie_id', 'kategorie_dalsi', 'upravil_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const nove = o.upravil_id
    ? {
        kategorie_id: o.kategorie_id ?? hlavni,
        kategorie_dalsi: [
          ...new Set(
            [...(o.kategorie_dalsi ?? []), hlavni, ...dalsi].filter((x) => x !== (o.kategorie_id ?? hlavni)),
          ),
        ],
      }
    : { kategorie_id: hlavni, kategorie_dalsi: dalsi };
  const stejne =
    nove.kategorie_id === o.kategorie_id &&
    nove.kategorie_dalsi.length === (o.kategorie_dalsi ?? []).length &&
    nove.kategorie_dalsi.every((x) => (o.kategorie_dalsi ?? []).includes(x));
  if (stejne) return;
  await ctx.s.db.updateTable('web_obsah').set(nove).where('id', '=', id).execute();
  ctx.vysledek.prerazeno++;
}

/** stránky rubrik starého webu → filtr rubriky v aktualitách (ručně nastavená přesměrování se nepřepisují) */
export async function presmerujRubriky(ctx: ImportKontext) {
  if (!ctx.zdroj.rubriky || !ctx.rubriky) return;
  const slugy = new Map(
    (await ctx.s.db.selectFrom('web_kategorie').select(['id', 'slug']).execute()).map((k) => [k.id, k.slug]),
  );
  for (const r of await ctx.zdroj.rubriky()) {
    const slug = slugy.get(ctx.rubriky.get(r.slug)!);
    if (!slug) continue;
    const stara = await ctx.s.presmerovani.cil(ctx.cesta(r.url));
    if (stara !== null && stara !== '/aktuality' && !stara.startsWith('/aktuality?kategorie=')) continue;
    await ctx.mapuj(r.url, `/aktuality?kategorie=${slug}`);
  }
}
