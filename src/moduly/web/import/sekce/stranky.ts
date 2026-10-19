// Import stránek: založení (nebo přepsání), strom podle zdroje a přesměrování starých adres.
import { PRAZDNA_POLE } from '../../obsah.js';
import type { ImportKontext } from '../kontext.js';
import { chybaSchematu, SCHEMA_STRANKY } from '../pomucky.js';
import type { ImportStranka } from '../typy.js';

export async function importujStranky(ctx: ImportKontext) {
  const vse: ImportStranka[] = [];
  for await (const st of ctx.zdroj.stranky()) {
    const p = SCHEMA_STRANKY.safeParse(st);
    if (p.success) vse.push(st);
    else ctx.chyba(`stránka ${String(st?.url ?? '?')}`, chybaSchematu(p.error));
  }
  const idPodleKlice = new Map<string, string>();
  for (const st of vse) {
    try {
      const existujici = await ctx.uzImportovano('web_obsah', st.url);
      if (existujici && !ctx.v.prepsat) {
        idPodleKlice.set(st.klic, existujici);
        ctx.vysledek.preskoceno++;
        continue;
      }
      const { html } = await ctx.prepisHtml(st.html, st.titulek, st.url);
      if (existujici) {
        await ctx.s.db
          .updateTable('web_obsah')
          .set({ obsah_html: html, upraveno_at: new Date() })
          .where('id', '=', existujici)
          .execute();
        idPodleKlice.set(st.klic, existujici);
        ctx.vysledek.stranky++;
        continue;
      }
      const id = await ctx.s.obsah.uloz(
        null,
        'stranka',
        {
          ...PRAZDNA_POLE,
          titulek: st.titulek.slice(0, 250),
          perex: (st.perex ?? '').slice(0, 600),
          obsah_html: html,
          v_menu: false,
        },
        'zverejnit',
        null,
        null,
        { zdroj: 'import', puvodniUrl: st.url, zverejnenoAt: st.datum ?? null },
      );
      idPodleKlice.set(st.klic, id);
      ctx.vysledek.stranky++;
      ctx.log(`stránka: ${st.titulek}`);
    } catch (e) {
      ctx.chyba(`stránka ${st.url}`, e);
    }
  }
  // strom podle zdroje (max. 2 úrovně: hlubší stránky se připojí pod nejvyššího předka)
  const podleKlice = new Map(vse.map((x) => [x.klic, x]));
  const koren = (st: ImportStranka): ImportStranka => {
    let a = st;
    for (let i = 0; i < 10 && a.rodic && podleKlice.has(a.rodic); i++) a = podleKlice.get(a.rodic)!;
    return a;
  };
  for (const st of vse) {
    const id = idPodleKlice.get(st.klic);
    if (!id) continue; // stránka se nepodařila
    const k = koren(st);
    const nadrazena = k.klic !== st.klic ? (idPodleKlice.get(k.klic) ?? null) : null;
    try {
      await ctx.s.db
        .updateTable('web_obsah')
        .set({ nadrazena_id: nadrazena, poradi: st.poradi ?? 0 })
        .where('id', '=', id)
        .execute();
    } catch (e) {
      ctx.chyba(`stránka ${st.url} (zařazení do stromu)`, e);
    }
  }
  // přesměrování až po sestavení stromu (adresa podstránky obsahuje rodiče)
  for (const st of vse) {
    const id = idPodleKlice.get(st.klic);
    if (!id) continue;
    try {
      const o = await ctx.s.obsah.podleId(id);
      if (o) await ctx.mapuj(st.url, await ctx.s.obsah.url(o));
    } catch (e) {
      ctx.chyba(`stránka ${st.url} (přesměrování)`, e);
    }
  }
  ctx.s.obsah.zmena();
  return idPodleKlice;
}
