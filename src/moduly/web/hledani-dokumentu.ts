// Hledání v textu dokumentů pro /hledat: výsledek z fulltextu souborů se převede na místo, kde dokument na webu je
// (příloha úřední desky → detail dokumentu, soubor ke stažení → /dokumenty, stránka či aktualita s odkazem na soubor
// → její adresa). Soubor, který nikde veřejně není (odebraná příloha, nikdy nepřipojený, neveřejný archiv desky),
// se ve výsledcích neukáže — mohl by obsahovat osobní údaje, které už z webu zmizely.
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { tsDotaz } from '../../lib/hledani.js';
import { urlSouboru } from '../../web/soubory.js';
import type { WebSluzby } from './index.js';

export interface VysledekHledani {
  typ: string;
  titulek: string;
  url: string;
  text: string;
  datum?: Date | null;
  /** úryvek z textu dokumentu (bezpečné HTML s <mark>) */
  uryvek?: string;
  /** klíč pro sloučení s ostatními výsledky (soubor nebo adresa) */
  klic?: string;
}

export async function vysledkyZDokumentu(
  app: FastifyInstance,
  s: WebSluzby,
  q: string,
  limit = 20,
): Promise<VysledekHledani[]> {
  const dotaz = tsDotaz(q);
  if (!dotaz || !app.env.TEXT_SOUBORU) return [];
  const nalezene = await app.textSouboru.hledej(dotaz, limit);
  if (!nalezene.length) return [];
  const ids = nalezene.map((n) => n.soubor_id);
  const t = app.t;
  const ted = new Date();

  // 1) přílohy úřední desky — veřejně viditelný dokument (vyvěšený, nebo sejmutý ve veřejném archivu)
  const deska = new Map<string, { id: string; nazev: string; datum: Date; archiv: boolean }>();
  const prilohaJenNeverejne = new Set<string>();
  if (app.obec.moduly.deska) {
    const prilohy = await app.db
      .selectFrom('ud_prilohy as p')
      .innerJoin('ud_dokumenty as d', 'd.id', 'p.dokument_id')
      .innerJoin('ud_kategorie as k', 'k.id', 'd.kategorie_id')
      .select([
        'p.soubor_id',
        'd.id',
        'd.nazev',
        'd.vyveseno_od',
        'd.sejmuto_do',
        'd.smazano_at',
        'k.archiv_verejny',
      ])
      .where('p.soubor_id', 'in', ids)
      .orderBy('d.vyveseno_od', 'desc')
      .execute();
    for (const p of prilohy) {
      const sejmuty = !!p.sejmuto_do && p.sejmuto_do <= ted;
      const verejny = !p.smazano_at && p.vyveseno_od <= ted && (!sejmuty || p.archiv_verejny);
      if (verejny) {
        if (!deska.has(p.soubor_id))
          deska.set(p.soubor_id, { id: p.id, nazev: p.nazev, datum: p.vyveseno_od, archiv: sejmuty });
      } else prilohaJenNeverejne.add(p.soubor_id);
    }
    for (const id of deska.keys()) prilohaJenNeverejne.delete(id);
  }

  // 2) soubory ke stažení
  const dokumenty = new Map<string, { id: string; nazev: string }>();
  for (const d of await app.db
    .selectFrom('web_dokumenty')
    .select(['id', 'nazev', 'soubor_id'])
    .where('soubor_id', 'in', ids)
    .where('smazano_at', 'is', null)
    .execute())
    if (!dokumenty.has(d.soubor_id)) dokumenty.set(d.soubor_id, { id: d.id, nazev: d.nazev });

  // 3) zveřejněná stránka / aktualita / akce, která na soubor odkazuje
  const obsah = new Map<string, { titulek: string; url: string; typ: string; datum: Date | null }>();
  const zbyle = ids.filter((id) => !deska.has(id) && !dokumenty.has(id) && !prilohaJenNeverejne.has(id));
  if (zbyle.length) {
    const vzor = `/soubory/(${zbyle.join('|')})`;
    const radky = await app.db
      .selectFrom('web_obsah')
      .select(['id', 'typ', 'titulek', 'slug', 'nadrazena_id', 'odkaz_url', 'datum', 'obsah_html'])
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .where('typ', '!=', 'odkaz')
      .where((eb) => eb.or([eb('typ', '!=', 'aktualita'), eb('datum', 'is', null), eb('datum', '<=', ted)]))
      .where(sql<boolean>`obsah_html ~ ${vzor}`)
      .orderBy('datum', 'desc')
      .limit(100)
      .execute();
    const adresy = await s.obsah.urlMnoha(radky);
    for (const [i, o] of radky.entries())
      for (const id of zbyle)
        if (!obsah.has(id) && o.obsah_html.includes(`/soubory/${id}`))
          obsah.set(id, {
            titulek: o.titulek,
            url: adresy[i]!,
            typ: t(`web.typ_${o.typ}`),
            datum: o.typ === 'stranka' ? null : o.datum,
          });
  }

  const out: VysledekHledani[] = [];
  for (const n of nalezene) {
    const d = deska.get(n.soubor_id);
    if (d) {
      out.push({
        typ: d.archiv ? t('web.typ_deska_archiv') : t('deska.titulek'),
        titulek: d.nazev,
        url: `/uredni-deska/${d.id}`,
        text: n.puvodni_nazev,
        datum: d.datum,
        uryvek: n.uryvek,
        klic: `/uredni-deska/${d.id}`,
      });
      continue;
    }
    const w = dokumenty.get(n.soubor_id);
    if (w) {
      out.push({
        typ: t('web.dokumenty'),
        titulek: w.nazev,
        url: `/dokumenty#d-${w.id}`,
        text: n.puvodni_nazev,
        uryvek: n.uryvek,
        klic: `soubor:${n.soubor_id}`,
      });
      continue;
    }
    const o = obsah.get(n.soubor_id);
    if (o) {
      out.push({
        typ: o.typ,
        titulek: o.titulek,
        url: o.url,
        text: t('text.v_priloze', { nazev: n.puvodni_nazev }),
        datum: o.datum,
        uryvek: n.uryvek,
        klic: o.url,
      });
    }
    // jinde nepoužitý (nebo jen neveřejný) soubor se neukazuje
  }
  return out;
}

/** klíč existujícího výsledku hledání pro sloučení s výsledky z dokumentů */
export function klicVysledku(v: { url: string; souborId?: string }): string {
  return v.souborId ? `soubor:${v.souborId}` : v.url;
}

export { urlSouboru };
