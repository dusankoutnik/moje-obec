// Obecní zpravodaj přes API (docs/ZPRAVODAJ-API.md): metadata JSON + PDF (+ tisková verze, obálka) → příspěvek
// v kategorii „zpravodaj“ s obsahem čísla, tabulkami evidence a hospodaření a tiráží; metadata v web_zpravodaj.
// Počet obyvatel v úvodu webu bere poslední zveřejněné číslo s evidence.obyvatel (obyvatelZeZpravodaje).
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Soubor } from '../../db/types.js';
import { casPraha, datumPraha } from '../../lib/datum.js';
import { escapujHtml as e, zkrat } from '../../lib/html.js';
import { lidskaVelikost } from '../../lib/soubory.js';
import { urlSouboru } from '../../web/soubory.js';
import { PRAZDNA_POLE, type PoleObsahu } from '../web/obsah.js';
import { podobneNazvy } from '../web/akce-propojeni.js';

const DATUM = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'datum ve tvaru YYYY-MM-DD');
const CAS = z.string().regex(/^\d{1,2}:\d{2}$/, 'čas ve tvaru HH:MM');
const castka = z.number().finite().nullable().optional();
const pocet = z.number().int().nonnegative().nullable().optional();

export const METADATA = z.object({
  rocnik: z.number().int().min(1990).max(2100),
  cislo: z.number().int().min(1).max(99),
  titulek: z.string().max(250).optional(),
  vydano: DATUM,
  obdobi: z.string().max(100).optional(),
  perex: z.string().min(1).max(600),
  obsah: z
    .array(z.object({ strana: z.number().int().positive().optional(), nadpis: z.string().min(1).max(200) }))
    .max(100)
    .optional(),
  evidence: z.object({
    k: DATUM,
    obyvatel: z.number().int().positive(),
    pred_rokem: pocet,
    pred_5_lety: pocet,
    pred_10_lety: pocet,
    pred_20_lety: pocet,
    prihlaseni: pocet,
    odhlaseni: pocet,
    narozeni: pocet,
    umrti: pocet,
  }),
  hospodareni: z
    .object({
      k: DATUM,
      prijmy: castka,
      vydaje: castka,
      saldo: castka,
      zustatek_ucet: castka,
      zustatek_pokladna: castka,
    })
    .optional(),
  akce: z
    .array(
      z.object({
        nazev: z.string().min(1).max(200),
        datum: DATUM.optional(),
        datum_do: DATUM.optional(),
        od: CAS.optional(),
        do: CAS.optional(),
        misto: z.string().max(200).optional(),
        poznamka: z.string().max(500).optional(),
        odkaz: z.string().url().max(500).optional(),
        pravidelne: z.string().max(100).optional(),
        od_data: DATUM.optional(),
      }),
    )
    .max(100)
    .optional(),
  tiraz: z.record(z.string(), z.string().max(300)).optional(),
  zverejnit: z.boolean().optional(),
  rozeslat: z.boolean().optional(),
});
export type MetadataZpravodaje = z.infer<typeof METADATA>;

const POPISKY_TIRAZE: Record<string, string> = {
  vydavatel: 'Vydavatel',
  redakce_email: 'Redakce',
  design: 'Grafická úprava',
  korektura: 'Korektura',
  foto_obalka: 'Foto na obálce',
  evidence_mk: 'Evidenční číslo',
};

const cz = (d: string) => {
  const [r, m, den] = d.split('-').map(Number);
  return `${den}. ${m}. ${r}`;
};
const cisloCz = (n: number, des = 0) =>
  n.toLocaleString('cs-CZ', { minimumFractionDigits: des, maximumFractionDigits: des });

/** HTML příspěvku čísla zpravodaje (vše escapované; výsledek ještě projde sanitizací) */
export function htmlZpravodaje(m: MetadataZpravodaje, pdf: Soubor, tisk: Soubor | null): string {
  const out: string[] = [];
  out.push(`<p>${e(m.perex)}</p>`);
  out.push('<h2>Ke stažení</h2><ul>');
  out.push(
    `<li><a href="${e(urlSouboru(pdf))}">Zpravodaj ${m.cislo}/${m.rocnik} (PDF, ${e(lidskaVelikost(pdf.velikost))})</a></li>`,
  );
  if (tisk)
    out.push(
      `<li><a href="${e(urlSouboru(tisk))}">Tisková verze (PDF, ${e(lidskaVelikost(tisk.velikost))})</a></li>`,
    );
  out.push('</ul>');
  if (m.obsah?.length) {
    out.push('<h2>V tomto čísle</h2><ul>');
    for (const k of m.obsah) out.push(`<li>${k.strana ? `str. ${k.strana} — ` : ''}${e(k.nadpis)}</li>`);
    out.push('</ul>');
  }
  const ev = m.evidence;
  const rEv: [string, number | null | undefined][] = [
    ['Počet obyvatel', ev.obyvatel],
    ['před rokem', ev.pred_rokem],
    ['před 5 lety', ev.pred_5_lety],
    ['před 10 lety', ev.pred_10_lety],
    ['před 20 lety', ev.pred_20_lety],
    ['přihlášení', ev.prihlaseni],
    ['odhlášení', ev.odhlaseni],
    ['narození', ev.narozeni],
    ['úmrtí', ev.umrti],
  ];
  out.push(`<h2>Z evidence obyvatel k ${cz(ev.k)}</h2><table><tbody>`);
  for (const [p, v] of rEv)
    if (v !== null && v !== undefined) out.push(`<tr><th scope="row">${p}</th><td>${cisloCz(v)}</td></tr>`);
  out.push('</tbody></table>');
  const h = m.hospodareni;
  if (h) {
    const rH: [string, number | null | undefined][] = [
      ['Příjmy', h.prijmy],
      ['Výdaje', h.vydaje],
      ['Saldo', h.saldo],
      ['Zůstatek na účtu', h.zustatek_ucet],
      ['Zůstatek v pokladně', h.zustatek_pokladna],
    ];
    const radky = rH.filter(([, v]) => v !== null && v !== undefined);
    if (radky.length) {
      out.push(`<h2>Hospodaření obce k ${cz(h.k)}</h2><table><tbody>`);
      for (const [p, v] of radky) out.push(`<tr><th scope="row">${p}</th><td>${cisloCz(v!, 2)} Kč</td></tr>`);
      out.push('</tbody></table>');
    }
  }
  const pravidelne = (m.akce ?? []).filter((a) => a.pravidelne);
  if (pravidelne.length) {
    out.push('<h2>Pravidelně</h2><ul>');
    for (const a of pravidelne) {
      const txt = [a.pravidelne, a.od, a.misto, a.od_data ? `od ${cz(a.od_data)}` : '', a.poznamka]
        .filter(Boolean)
        .join(', ');
      out.push(`<li>${a.odkaz ? `<a href="${e(a.odkaz)}">${e(a.nazev)}</a>` : e(a.nazev)} — ${e(txt)}</li>`);
    }
    out.push('</ul>');
  }
  const tiraz = Object.entries(m.tiraz ?? {}).filter(([, v]) => v);
  if (tiraz.length) {
    out.push('<h2>Tiráž</h2><ul>');
    for (const [k, v] of tiraz) {
      const hodnota =
        k === 'redakce_email' && /^[^@\s]+@[^@\s]+$/.test(v) ? `<a href="mailto:${e(v)}">${e(v)}</a>` : e(v);
      out.push(`<li>${e(POPISKY_TIRAZE[k] ?? k.replace(/_/g, ' '))}: ${hodnota}</li>`);
    }
    out.push('</ul>');
  }
  return out.join('\n');
}

export function poleZpravodaje(
  m: MetadataZpravodaje,
  html: string,
  kategorieId: number | null,
  obalkaId: string | null,
): PoleObsahu {
  return {
    ...PRAZDNA_POLE,
    titulek: (m.titulek || `Obecní zpravodaj ${m.cislo}/${m.rocnik}`).slice(0, 250),
    slug: `obecni-zpravodaj-${m.rocnik}-${m.cislo}`,
    perex: zkrat(m.perex, 600),
    obsah_html: html,
    kategorie_id: kategorieId,
    obrazek_id: obalkaId,
    datum: (casPraha(m.vydano, 8, 0) ?? new Date()).toISOString(),
    v_menu: false,
  };
}

/** počet obyvatel z nejnovějšího zveřejněného čísla zpravodaje (podle data vydání), nebo null */
export async function obyvatelZeZpravodaje(db: Db) {
  const r = await db
    .selectFrom('web_zpravodaj as z')
    .innerJoin('web_obsah as o', 'o.id', 'z.obsah_id')
    .select(['z.obyvatel', 'z.evidence_k', 'z.rocnik', 'z.cislo', 'z.vydano', 'o.slug'])
    .where('z.obyvatel', 'is not', null)
    .where('o.stav', '=', 'zverejneno')
    .where('o.smazano_at', 'is', null)
    .orderBy('z.vydano', 'desc')
    .orderBy('z.rocnik', 'desc')
    .orderBy('z.cislo', 'desc')
    .executeTakeFirst();
  if (!r || r.obyvatel === null) return null;
  return {
    obyvatel: r.obyvatel,
    titulek: `podle Zpravodaje ${r.cislo}/${r.rocnik}${r.evidence_k ? ` (k ${cz(r.evidence_k)})` : ''}`,
    url: `/aktuality/${r.slug}`,
  };
}

/** akce z metadat → koncepty akcí (jen budoucí jednorázové, jen když v kalendáři webu ještě nejsou) */
export async function akceZeZpravodaje(
  app: FastifyInstance,
  m: MetadataZpravodaje,
  aktorId: string | null,
  ted = new Date(),
): Promise<
  { nazev: string; stav: 'koncept' | 'existuje' | 'pravidelna' | 'probehla' | 'bez_data'; id?: string }[]
> {
  const out: {
    nazev: string;
    stav: 'koncept' | 'existuje' | 'pravidelna' | 'probehla' | 'bez_data';
    id?: string;
  }[] = [];
  const dnes = datumPraha(ted);
  for (const a of m.akce ?? []) {
    if (a.pravidelne) {
      out.push({ nazev: a.nazev, stav: 'pravidelna' });
      continue;
    }
    if (!a.datum) {
      out.push({ nazev: a.nazev, stav: 'bez_data' });
      continue;
    }
    if ((a.datum_do ?? a.datum) < dnes) {
      out.push({ nazev: a.nazev, stav: 'probehla' });
      continue;
    }
    const externi = `${m.rocnik}-${m.cislo}:${a.datum}:${a.nazev}`.slice(0, 300);
    const uz = await app.db
      .selectFrom('web_obsah')
      .select('id')
      .where('zdroj', '=', 'zpravodaj')
      .where('externi_id', '=', externi)
      .executeTakeFirst();
    if (uz) {
      out.push({ nazev: a.nazev, stav: 'existuje', id: uz.id });
      continue;
    }
    // stejný den a podobný název v kalendáři webu (i koncept) → nezakládat
    const den0 = casPraha(a.datum, 0, 0)!;
    const den1 = casPraha(a.datum, 23, 59, 59)!;
    const tentyzDen = await app.db
      .selectFrom('web_obsah')
      .select(['id', 'titulek'])
      .where('typ', '=', 'akce')
      .where('smazano_at', 'is', null)
      .where('datum', '>=', den0)
      .where('datum', '<=', den1)
      .execute();
    const shoda = tentyzDen.find((x) => podobneNazvy(x.titulek, a.nazev));
    if (shoda) {
      out.push({ nazev: a.nazev, stav: 'existuje', id: shoda.id });
      continue;
    }
    const [h1, m1] = a.od ? a.od.split(':').map(Number) : [0, 0];
    const zac = casPraha(a.datum, h1!, m1!)!;
    let konec: Date | null = null;
    if (a.datum_do || a.do) {
      const [h2, m2] = a.do ? a.do.split(':').map(Number) : [23, 59];
      konec = casPraha(a.datum_do ?? a.datum, h2!, m2!);
      if (konec && konec <= zac) konec = null;
    }
    const text = [
      a.poznamka ? `<p>${e(a.poznamka)}</p>` : '',
      a.odkaz ? `<p><a href="${e(a.odkaz)}">${e(a.odkaz)}</a></p>` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const id = await app.web.obsah.uloz(
      null,
      'akce',
      {
        ...PRAZDNA_POLE,
        titulek: a.nazev,
        obsah_html: text,
        datum: zac.toISOString(),
        akce_konec: konec?.toISOString() ?? null,
        akce_cely_den: !a.od,
        akce_misto: a.misto ?? '',
        v_menu: false,
      },
      'koncept',
      aktorId,
      null,
      { zdroj: 'zpravodaj' },
    );
    await app.db.updateTable('web_obsah').set({ externi_id: externi }).where('id', '=', id).execute();
    out.push({ nazev: a.nazev, stav: 'koncept', id });
  }
  return out;
}
