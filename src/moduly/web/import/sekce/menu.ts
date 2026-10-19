// Import menu starého webu: strom stránek, rozcestníky pro podnabídky a odkazy.
import { sql } from 'kysely';
import { PRAZDNA_POLE } from '../../obsah.js';
import type { ImportKontext, Sluzby } from '../kontext.js';
import { hezkyTitulek } from '../pomucky.js';
import type { ImportMenu } from '../typy.js';

/**
 * Menu starého webu → strom stránek a odkazů (stránky, které v menu nejsou, zůstanou mimo menu). Celé menu
 * v jedné transakci: buď se postaví celé, nebo zůstane předchozí. Mění jen to, co založil import, a výchozí
 * položky instalace — ruční úpravy redakce nechává být.
 */
export async function importujMenu(ctx: ImportKontext) {
  if (!ctx.zdroj.menu) return;
  const menu = await ctx.zdroj.menu();
  if (!menu.length) return;
  await ctx.vTransakci((s) => postavMenu(ctx, s, menu));
}

async function postavMenu(ctx: ImportKontext, s: Sluzby, menu: ImportMenu[]) {
  // dřívější import menu: odkazy ze zdroje „import“ smazat (koš) a postavit znovu
  await s.db
    .updateTable('web_obsah')
    .set({ smazano_at: new Date() })
    .where('typ', '=', 'odkaz')
    .where('zdroj', '=', 'import')
    .where('smazano_at', 'is', null)
    .execute();
  // nová adresa pro starou URL — jen pro odkazy na vlastní web (cizí weby zůstávají, jak jsou)
  const adresa = async (url: string | null): Promise<string | null> => {
    if (!url || !ctx.jeNasUrl(url)) return null;
    const klic = ctx.cesta(url).toLowerCase();
    return ctx.mapa.get(klic) ?? (await s.presmerovani.cil(klic));
  };
  const stranka = async (url: string | null) => {
    if (!url) return null;
    const r = await s.db
      .selectFrom('web_obsah')
      .select(['id', 'typ'])
      .where('puvodni_url', '=', url)
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
    return r?.typ === 'stranka' ? r.id : null;
  };
  const odkaz = async (titulek: string, url: string, nadrazena: string | null, poradi: number) => {
    const id = await s.obsah.uloz(
      null,
      'odkaz',
      { ...PRAZDNA_POLE, titulek, odkaz_url: url, nadrazena_id: nadrazena, v_menu: true },
      'zverejnit',
      null,
      null,
      { zdroj: 'import' },
    );
    await s.db.updateTable('web_obsah').set({ poradi }).where('id', '=', id).execute();
    ctx.vysledek.menu++;
  };
  // výchozí menu nové instalace (Aktuality, Úřední deska, Kontakt — založené systémem, bez autora) nahradí
  // menu starého webu; odkazy, které přidala redakce, zůstávají
  await s.db
    .updateTable('web_obsah')
    .set({ v_menu: false })
    .where('typ', '=', 'odkaz')
    .where('zdroj', '=', '')
    .where('autor_id', 'is', null)
    .where('smazano_at', 'is', null)
    .execute();
  // vše, co dřív bylo v menu z importu, z menu vyjmout — menu určí jen tento import
  await s.db
    .updateTable('web_obsah')
    .set({ v_menu: false })
    .where('zdroj', '=', 'import')
    .where('typ', '=', 'stranka')
    .where('smazano_at', 'is', null)
    .execute();
  // podnabídka do jedné úrovně (hlubší položky se zařadí za svého předka, položky bez odkazu vypadnou)
  const zplosti = (polozky: ImportMenu[]): ImportMenu[] =>
    polozky.flatMap((p) => [
      ...(p.url ? [{ titulek: p.titulek, url: p.url, deti: [] as ImportMenu[] }] : []),
      ...zplosti(p.deti),
    ]);
  const preskocit = (p: ImportMenu) =>
    /^(více|vice|úvod|uvod|home|domů)\b/i.test(p.titulek.trim()) || p.titulek.includes('→');
  let poradi = 100;
  for (const m of menu) {
    if (preskocit(m)) continue;
    poradi += 10;
    const titulek = hezkyTitulek(m.titulek);
    const deti = zplosti(m.deti).filter((d) => !preskocit(d));
    const strankaMenu = await stranka(m.url);
    let rodic: string | null = deti.length ? null : strankaMenu;
    if (deti.length) {
      // položka s podnabídkou → rozcestník (stránka s dlaždicemi podstránek), titulek z menu
      const klic = `menu:${titulek}`;
      rodic =
        (
          await s.db
            .selectFrom('web_obsah')
            .select('id')
            .where('puvodni_url', '=', klic)
            .where('smazano_at', 'is', null)
            .executeTakeFirst()
        )?.id ??
        (await s.obsah.uloz(
          null,
          'stranka',
          { ...PRAZDNA_POLE, titulek, v_menu: true },
          'zverejnit',
          null,
          null,
          { zdroj: 'import', puvodniUrl: klic },
        ));
      // stará adresa položky (např. stránka kategorie) → rozcestník, jen když nemá lepší cíl
      if (m.url && !strankaMenu && !(await adresa(m.url)))
        await ctx.mapuj(m.url, await s.obsah.url((await s.obsah.podleId(rodic))!), s);
    }
    if (rodic) {
      await s.db
        .updateTable('web_obsah')
        .set({ nadrazena_id: null, v_menu: true, poradi })
        .where('id', '=', rodic)
        .execute();
    } else if (m.url) {
      await odkaz(
        titulek,
        (await adresa(m.url)) ?? (ctx.jeNasUrl(m.url) ? ctx.cesta(m.url) : m.url),
        null,
        poradi,
      );
      continue;
    }
    let p2 = 0;
    for (const d of deti) {
      p2 += 10;
      const st = await stranka(d.url);
      if (st && st !== rodic) {
        await s.db
          .updateTable('web_obsah')
          .set({ nadrazena_id: rodic, v_menu: true, poradi: p2 })
          .where('id', '=', st)
          .execute();
      } else if (d.url && !st) {
        const cil = (await adresa(d.url)) ?? (ctx.jeNasUrl(d.url) ? ctx.cesta(d.url) : d.url);
        await odkaz(hezkyTitulek(d.titulek), cil, rodic, p2);
      }
    }
  }
  // podstránky importované stránky, která se v menu ocitla jako podstránka, by byly 3. úroveň → povýšit pod
  // nejvyššího předka (jen stránky z importu; zbytek webu se nemění)
  await sql`UPDATE web_obsah c SET nadrazena_id = p.nadrazena_id FROM web_obsah p
    WHERE c.nadrazena_id = p.id AND p.nadrazena_id IS NOT NULL
      AND p.zdroj = 'import' AND c.smazano_at IS NULL AND p.smazano_at IS NULL`.execute(s.db);
  // adresy podstránek se mohly změnit → přesměrování přepočítat
  const importovane = (
    await s.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('typ', '=', 'stranka')
      .where('zdroj', '=', 'import')
      .where('smazano_at', 'is', null)
      .where('puvodni_url', 'is not', null)
      .execute()
  ).filter((o) => !o.puvodni_url!.startsWith('menu:'));
  for (const o of importovane) await ctx.mapuj(o.puvodni_url!, await s.obsah.url(o), s);
}
