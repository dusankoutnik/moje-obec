// Import dotací: projekt, loga poskytovatelů a zobrazení na webu.
import { datumPraha } from '../../../../lib/datum.js';
import type { ImportKontext } from '../kontext.js';

export async function importujDotace(ctx: ImportKontext) {
  if (!ctx.zdroj.dotace) return;
  for (const d of await ctx.zdroj.dotace()) {
    try {
      const existuje = await ctx.s.db
        .selectFrom('web_dotace')
        .select('id')
        .where('projekt', '=', d.projekt)
        .where('smazano_at', 'is', null)
        .executeTakeFirst();
      if (existuje) {
        ctx.vysledek.preskoceno++;
        continue;
      }
      const loga: string[] = [];
      for (const l of d.loga) {
        const r = await ctx.soubor(l.url, 'logo', l.alt || d.poskytovatel || d.projekt);
        if (r) loga.push(r.id);
      }
      await ctx.vTransakci(async (s) => {
        const id = await s.dotace.uloz(
          null,
          {
            projekt: d.projekt,
            poskytovatel: d.poskytovatel ?? '',
            text: d.text ?? '',
            odkaz: d.odkaz ?? '',
          },
          null,
        );
        await s.dotace.pridejLoga(id, loga);
        await s.dotace.zobrazeni(
          id,
          { od: datumPraha(new Date()), do: null, vPaticce: false, poradi: 100 },
          null,
        );
      });
      ctx.vysledek.dotace++;
    } catch (e) {
      ctx.chyba(`dotace ${d.projekt}`, e);
    }
  }
}
