// Import úřední desky: dokumenty od nejstaršího (kvůli nahrazení rozpočtové dokumentace), přílohy, doba vyvěšení.
import { datumPraha, pridejDny } from '../../../../lib/datum.js';
import { textZHtml, zkrat } from '../../../../lib/html.js';
import type { DeskaSluzba } from '../../../deska/sluzba.js';
import type { ImportKontext } from '../kontext.js';
import { absolutni, chybaSchematu, odhadniRozpocet, SCHEMA_DOKUMENTU } from '../pomucky.js';
import type { ImportDokument } from '../typy.js';

export async function importujDesku(ctx: ImportKontext) {
  if (!ctx.s.deska || !ctx.zdroj.deska) return;
  const kategorie = await ctx.s.deska.kategorie(false);
  const dokumenty: ImportDokument[] = [];
  for await (const d of ctx.zdroj.deska(ctx.v.deskaOd)) {
    const p = SCHEMA_DOKUMENTU.safeParse(d);
    if (p.success) dokumenty.push(d);
    else ctx.chyba(`úřední deska ${String(d?.url ?? '?')}`, chybaSchematu(p.error));
  }
  // od nejstaršího, aby nové rozpočtové dokumenty správně nahradily starší
  dokumenty.sort((a, b) => a.vyvesenoOd.getTime() - b.vyvesenoOd.getTime());
  for (const d of dokumenty) {
    try {
      await importujDokument(ctx, d, kategorie);
    } catch (e) {
      ctx.chyba(`úřední deska ${d.url}`, e);
    }
  }
}

async function importujDokument(
  ctx: ImportKontext,
  d: ImportDokument,
  kategorie: Awaited<ReturnType<DeskaSluzba['kategorie']>>,
) {
  const letos = new Date().getFullYear();
  const existujici = await ctx.uzImportovano('ud_dokumenty', d.url);
  if (existujici) {
    ctx.vysledek.preskoceno++;
    return;
  }
  const kat = kategorie.find((k) => k.slug === d.kategorie) ?? kategorie.find((k) => k.slug === 'ostatni')!;
  const { html, prilohy } = await ctx.prepisHtml(d.html, d.nazev, d.url);
  for (const p of d.prilohy ?? []) {
    const abs = absolutni(p.url, d.url) ?? absolutni(p.url, ctx.zdroj.zaklad);
    const r = abs ? await ctx.soubor(abs, 'dokument', d.nazev) : null;
    if (r) prilohy.push(r.id);
  }
  const od = datumPraha(d.vyvesenoOd);
  const rozpocet = kat.rozpocet ? odhadniRozpocet(d.nazev, d.vyvesenoOd) : null;
  let doo: string | null;
  if (d.sejmutoDo) doo = datumPraha(d.sejmutoDo);
  else if (rozpocet && rozpocet.typ !== 'rozpoctove_opatreni')
    doo = null; // do zveřejnění nového (nahradí ho sám)
  else if (rozpocet) doo = rozpocet.rok >= letos ? null : pridejDny(od, Math.max(kat.vychozi_dni, 15));
  else doo = kat.vychozi_dni > 0 ? pridejDny(od, Math.max(kat.vychozi_dni, kat.min_dni)) : null;
  const popis = zkrat(textZHtml(html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '')), 3000);
  // dokument, přílohy a přesměrování v jedné transakci (jinak by příště zůstal dokument bez příloh)
  await ctx.vTransakci(async (s) => {
    const id = await s.deska!.uloz(
      null,
      {
        nazev: d.nazev.slice(0, 300),
        kategorieId: kat.id,
        cisloJednaci: d.cisloJednaci ?? '',
        puvodce: '',
        popis,
        od,
        do: doo,
        typRozpoctu: rozpocet?.typ ?? null,
        rok: rozpocet?.rok ?? null,
      },
      null,
      null,
      d.url,
    );
    await s.deska!.pridejPrilohy(id, [...new Set(prilohy)]);
    await ctx.mapuj(d.url, `/uredni-deska/${id}`, s);
  });
  ctx.vysledek.deska++;
  if (ctx.vysledek.deska % 50 === 0) ctx.log(`úřední deska: ${ctx.vysledek.deska}`);
}
