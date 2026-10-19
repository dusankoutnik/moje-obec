// Import aktualit: kontrola duplicit (stejná zpráva z jiného zdroje), obrázek, článek + přesměrování v transakci.
import { datumPraha } from '../../../../lib/datum.js';
import { altZeZdroje, textZHtml, zkrat } from '../../../../lib/html.js';
import { PRAZDNA_POLE } from '../../obsah.js';
import type { ImportKontext } from '../kontext.js';
import {
  absolutni,
  chybaSchematu,
  dekodujBezpecne,
  klicTitulku,
  podobnyTitulek,
  SCHEMA_CLANKU,
} from '../pomucky.js';
import type { ImportClanek } from '../typy.js';

/**
 * už je na webu (nebo ve známém seznamu) aktualita s podobným titulkem a datem ±3 dny? Stejný den a stejný
 * začátek textu se počítá taky (jiná verze téže zprávy s jinak odvozeným titulkem).
 */
export async function duplicita(
  ctx: ImportKontext,
  titulek: string,
  datum: Date,
  html = '',
): Promise<string | null> {
  if (!ctx.zname) {
    const naWebu = await ctx.s.db
      .selectFrom('web_obsah')
      .select(['titulek', 'datum', 'puvodni_url', 'perex'])
      .where('typ', '=', 'aktualita')
      .where('smazano_at', 'is', null)
      .execute();
    ctx.zname = [
      ...naWebu
        .filter((o) => o.datum)
        .map((o) => ({
          titulek: o.titulek,
          datum: new Date(o.datum!),
          popis: o.puvodni_url ?? 'web',
          text: o.perex,
        })),
      ...(ctx.v.znameClanky ?? []).map((z) => ({
        ...z,
        popis: z.zdroj ?? 'známý seznam',
        text: z.text ?? '',
      })),
    ];
  }
  const t = datum.getTime();
  const zacatek = klicTitulku(textZHtml(html).slice(0, 60));
  const shoda = ctx.zname.find(
    (z) =>
      Math.abs(z.datum.getTime() - t) <= 3 * 86_400_000 &&
      (podobnyTitulek(z.titulek, titulek) ||
        (zacatek.length >= 30 &&
          datumPraha(z.datum) === datumPraha(datum) &&
          klicTitulku(z.text.slice(0, 60)) === zacatek)),
  );
  return shoda ? `${shoda.titulek} (${datumPraha(shoda.datum)}, ${shoda.popis})` : null;
}

export async function importujAktuality(ctx: ImportKontext) {
  const kategorie = new Map(
    (await ctx.s.db.selectFrom('web_kategorie').select(['id', 'slug']).execute()).map((k) => [k.slug, k.id]),
  );
  for await (const a of ctx.zdroj.aktuality(ctx.v.aktualityOd)) {
    const p = SCHEMA_CLANKU.safeParse(a);
    if (!p.success) {
      ctx.chyba(`aktualita ${String(a?.url ?? '?')}`, chybaSchematu(p.error));
      continue;
    }
    try {
      await importujAktualitu(ctx, a, kategorie);
    } catch (e) {
      ctx.chyba(`aktualita ${a.url}`, e);
    }
  }
}

async function importujAktualitu(ctx: ImportKontext, a: ImportClanek, kategorie: Map<string, number>) {
  const existujici = await ctx.uzImportovano('web_obsah', a.url);
  if (existujici && !ctx.v.prepsat) {
    ctx.vysledek.preskoceno++;
    return;
  }
  const dup = !existujici && ctx.v.kontrolaDuplicit ? await duplicita(ctx, a.titulek, a.datum, a.html) : null;
  if (dup) {
    ctx.vysledek.duplicity.push(`${a.titulek} (${datumPraha(a.datum)}) = ${dup}`);
    ctx.vysledek.preskoceno++;
    return;
  }
  const { html } = await ctx.prepisHtml(a.html, a.titulek, a.url);
  if (existujici) {
    await ctx.s.db
      .updateTable('web_obsah')
      .set({ obsah_html: html, upraveno_at: new Date() })
      .where('id', '=', existujici)
      .execute();
    ctx.vysledek.aktuality++;
    return;
  }
  // média se stahují mimo transakci (soubor bez článku nevadí — příště se použije znovu podle adresy)
  let obrazekId: string | null = null;
  if (a.obrazekUrl) {
    const abs = absolutni(a.obrazekUrl, ctx.zdroj.zaklad);
    if (abs) {
      const nazev = dekodujBezpecne(new URL(abs).pathname.split('/').pop() ?? '');
      const r = await ctx.soubor(abs, 'obrazek', altZeZdroje(a.obrazekAlt, nazev));
      obrazekId = r?.id ?? null;
    }
  }
  const slugKat = a.kategorie ? ctx.v.kategorieAktualit?.[a.kategorie] : undefined;
  // článek a jeho přesměrování buď oba, nebo nic (jinak by příští běh článek přeskočil a 301 by chyběla)
  await ctx.vTransakci(async (s) => {
    const id = await s.obsah.uloz(
      null,
      'aktualita',
      {
        ...PRAZDNA_POLE,
        titulek: a.titulek.slice(0, 250),
        perex: zkrat(a.perex?.trim() || textZHtml(html), 300),
        obsah_html: html,
        obrazek_id: obrazekId,
        kategorie_id: slugKat ? (kategorie.get(slugKat) ?? null) : null,
        datum: a.datum.toISOString(),
      },
      'zverejnit',
      null,
      null,
      { zdroj: 'import', puvodniUrl: a.url, zverejnenoAt: a.datum },
    );
    const o = await s.obsah.podleId(id);
    if (o && !ctx.v.archiv) await ctx.mapuj(a.url, await s.obsah.url(o), s);
  });
  ctx.zname?.push({ titulek: a.titulek, datum: a.datum, popis: a.url, text: textZHtml(html) });
  ctx.vysledek.aktuality++;
  if (ctx.vysledek.aktuality % 25 === 0) ctx.log(`aktuality: ${ctx.vysledek.aktuality}`);
}
