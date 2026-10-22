// Veřejná část obecního webu: titulní stránka, stránky podle menu, aktuality (+ RSS), akce, galerie, dokumenty,
// dotace, hledání. Neznámé adresy: nejdřív stránka webu, pak tabulka přesměrování starých URL (301), jinak 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { escapujHtml, perexOpakujeText, textZHtml, zkrat } from '../../lib/html.js';
import { lidskaVelikost, popisTypu } from '../../lib/soubory.js';
import { jeBezpecnyOdkaz } from '../../lib/navrat.js';
import { cisloStrany } from '../../lib/vstupy.js';
import { urlSouboru } from '../../web/soubory.js';
import type { WebSluzby } from './index.js';
import { rozdelPodleVidei } from './videa.js';
import { odkazAkce } from './akce-externi.js';
import { pomocniciOdstavek } from '../odstavky/index.js';
import { klicVysledku, vysledkyZDokumentu, type VysledekHledani } from './hledani-dokumentu.js';

/** akce webu + akce z rezervací, seřazené podle začátku */
function sloucAkce<T extends { datum: Date | null }, U extends { datum: Date }>(
  web: T[],
  externi: U[],
): (T | U)[] {
  return [...web, ...externi].sort((a, b) => (a.datum?.getTime() ?? 0) - (b.datum?.getTime() ?? 0));
}

async function webVerejne(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;

  /**
   * Nadcházející akce webu + termíny z rezervací. Termín propojený se ZVEŘEJNĚNOU akcí webu se nahradí touto akcí
   * (odkaz /akce/<slug>); u série se bere nejbližší výskyt a text opakování z rezervací. Akce webu, která je
   * takto zastoupená, se podruhé nevypisuje.
   */
  async function nadchazejiciAkce(limitWebu: number) {
    const [akceWebu, externi] = await Promise.all([s.obsah.akce({ limit: limitWebu }), s.kalendar.akce()]);
    const propojene = await s.propojeni.zverejnenePropojene(externi.map((e) => e.ref));
    const podleRef = new Map(propojene.map((a) => [a.rezervace_ref!, a]));
    const ted = new Date();
    const zastoupene = new Set<string>();
    const ext: ((typeof externi)[number] | (typeof propojene)[number] | Record<string, unknown>)[] = [];
    for (const e of externi) {
      const a = podleRef.get(e.ref);
      if (!a) {
        ext.push(e);
        continue;
      }
      if (zastoupene.has(a.id)) continue;
      zastoupene.add(a.id);
      if (e.opakovani)
        ext.push({
          ...a,
          datum: e.datum,
          akce_konec: e.akce_konec,
          akce_cely_den: e.akce_cely_den,
          opakovani: e.opakovani,
        });
      // jednorázová akce: platí termín z webu (redaktor ho mohl upravit); proběhlá už mezi nadcházející nepatří
      else if (a.datum && (a.akce_konec ?? new Date(a.datum.getTime() + 86_400_000)) >= ted) ext.push(a);
    }
    return sloucAkce(
      akceWebu.filter((a) => !zastoupene.has(a.id)),
      ext as { datum: Date }[],
    ) as (Awaited<ReturnType<typeof s.obsah.akce>>[number] & {
      externi?: boolean;
      url?: string | null;
      opakovani?: string | null;
    })[];
  }

  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, zkrat, textZHtml, odkazAkce };
  const obr = (id: string | null, nazev: string | null | undefined, nahled = true) =>
    id ? urlSouboru({ id, puvodni_nazev: nazev ?? 'obrazek.jpg' }, nahled) : '';

  app.decorate('webUvod', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [aktuality, vsechnyAkce, dotace, videaTitulky, videaCelkem] = await Promise.all([
      s.obsah.aktuality({ naStranku: 4 }),
      nadchazejiciAkce(6),
      s.dotace.aktivni(),
      s.videa.seznam({ verejne: true, naTitulce: true, limit: 4 }),
      s.videa.pocetVerejnych(),
    ]);
    const videa = await s.videa.proZobrazeni(videaTitulky);
    const akce = vsechnyAkce.slice(0, 3); // panel „Nadcházející akce“
    const vsechnaDeska = app.obec.moduly.deska ? await app.deska.aktualni() : [];
    const deska = vsechnaDeska.slice(0, 5);
    // živé statistiky do úvodu — jen agregáty, žádná jména
    const statistiky: { hodnota: string; cislo?: number; popisek: string; odkaz?: string }[] = [];
    for (const f of app.obec.obec.fakta.slice(0, 3)) {
      const c = /^\d+$/.test(f.hodnota) ? Number(f.hodnota) : undefined;
      statistiky.push({ hodnota: f.hodnota, cislo: c, popisek: f.popisek, odkaz: f.odkaz });
    }
    if (app.obec.moduly.deska)
      statistiky.push({
        hodnota: String(vsechnaDeska.length),
        cislo: vsechnaDeska.length,
        popisek: t('web.stat_deska'),
        odkaz: '/uredni-deska',
      });
    if (
      app.obec.moduly.infokanal &&
      (!app.hasDecorator('moduly') || (await app.moduly.zapnuto('infokanal')))
    ) {
      const n = (await app.infokanal.statistiky()).celkem;
      if (n > 0)
        statistiky.push({
          hodnota: String(n),
          cislo: n,
          popisek: t('web.stat_odberatele'),
          odkaz: '/infokanal',
        });
    }
    // zprávy za poslední měsíc: jen kategorie z obec.yml (web.stat_zpravy_kategorie), jinak všechny aktuality
    const pred30 = new Date(Date.now() - 30 * 86_400_000);
    const slugZprav = app.obec.web.stat_zpravy_kategorie;
    const katZprav = slugZprav ? (await s.obsah.kategorie()).find((k) => k.slug === slugZprav) : undefined;
    let dotazZprav = app.db
      .selectFrom('web_obsah')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('typ', '=', 'aktualita')
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .where('datum', '>=', pred30)
      .where('datum', '<=', new Date());
    if (katZprav) dotazZprav = dotazZprav.where('kategorie_id', '=', katZprav.id);
    const noveAktuality = await dotazZprav.executeTakeFirstOrThrow();
    statistiky.push({
      hodnota: String(Number(noveAktuality.n)),
      cislo: Number(noveAktuality.n),
      popisek: t('web.stat_aktuality'),
      odkaz: katZprav ? `/aktuality?kategorie=${encodeURIComponent(katZprav.slug)}` : '/aktuality',
    });
    // pět nejbližších akcí (web + rezervace sálu a hřišť + předprodej), každá vede na svou stránku
    vsechnyAkce.slice(0, 5).forEach((a, i) => {
      if (!a.datum) return;
      statistiky.push({
        hodnota: a.datum.toLocaleDateString('cs-CZ', {
          day: 'numeric',
          month: 'numeric',
          timeZone: 'Europe/Prague',
        }),
        popisek: t(i === 0 ? 'web.stat_akce' : 'web.stat_akce_dalsi', { nazev: zkrat(a.titulek, 40) }),
        odkaz: odkazAkce(a) ?? '/akce',
      });
    });
    // plánované odstávky elektřiny (modul odstavky) — jen budoucí a probíhající; žádná = na titulce nic
    const odstavky = app.odstavky ? await app.odstavky.stav() : null;
    return reply.view('web/uvod', {
      titulek: '',
      odstavky: odstavky?.aktualni.length ? odstavky : null,
      ...pomocniciOdstavek,
      aktuality: aktuality.radky,
      akce,
      deska,
      dotace,
      videa,
      videaCelkem,
      statistiky,
      plnaSirka: true,
      obr,
      ...pomocnici,
    });
  });

  app.get<{ Querystring: { kategorie?: string; strana?: string } }>('/aktuality', async (req, reply) => {
    const vsechny = await s.obsah.kategorie();
    const kategorie = await s.obsah.kategorieSObsahem();
    const k = vsechny.find((x) => x.slug === req.query.kategorie);
    const v = await s.obsah.aktuality({ kategorie: k?.id ?? null, stranka: cisloStrany(req.query.strana) });
    return reply.view('web/aktuality', {
      titulek: t('web.aktuality'),
      kategorie,
      aktivni: k?.slug ?? '',
      ...v,
      obr,
      ...pomocnici,
    });
  });

  app.get('/aktuality/rss.xml', async (_req, reply) => {
    const { radky } = await s.obsah.aktuality({ naStranku: 30 });
    const base = app.env.BASE_URL;
    const x = escapujHtml;
    const polozky = radky
      .map(
        (a) =>
          `<item><title>${x(a.titulek)}</title><link>${base}/${a.typ === 'akce' ? 'akce' : 'aktuality'}/${a.slug}</link><guid isPermaLink="false">${a.id}</guid>${a.datum ? `<pubDate>${a.datum.toUTCString()}</pubDate>` : ''}<description>${x(a.perex)}</description></item>`,
      )
      .join('\n');
    return reply
      .type('application/rss+xml; charset=utf-8')
      .send(
        `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>${x(t('web.aktuality'))} — ${x(app.obec.obec.nazev)}</title><link>${base}/aktuality</link><description>${x(t('web.aktuality'))}</description><language>cs</language>\n${polozky}\n</channel></rss>`,
      );
  });

  async function detail(
    reply: FastifyReply,
    o: NonNullable<Awaited<ReturnType<typeof s.obsah.podleId>>>,
    extra: Record<string, unknown> = {},
  ) {
    const obrazek = o.obrazek_id ? await app.soubory.podleId(o.obrazek_id) : undefined;
    const kategorie = o.kategorie_id
      ? (await s.obsah.kategorie()).find((k) => k.id === o.kategorie_id)
      : undefined;
    return reply.view('web/obsah', {
      titulek: o.titulek,
      popis: o.perex || zkrat(textZHtml(o.obsah_html), 160),
      o,
      zobrazitPerex: !!o.perex && !perexOpakujeText(o.perex, o.obsah_html),
      castiObsahu: rozdelPodleVidei(o.obsah_html, await s.videa.vTextu(o.obsah_html)),
      obrazek,
      kategorie,
      ...pomocnici,
      ...extra,
    });
  }

  app.get<{ Params: { slug: string } }>('/aktuality/:slug', async (req, reply) => {
    const o = await s.obsah.podleSlugu('aktualita', req.params.slug);
    if (!o) return reply.callNotFound(); // naplánované (budoucí) odfiltruje už služba
    return detail(reply, o, { zpet: { url: '/aktuality', text: t('web.aktuality') } });
  });

  app.get<{ Querystring: { probehle?: string } }>('/akce', async (req, reply) => {
    const probehle = req.query.probehle === '1';
    // akce sálu, hřišť a předprodeje z rezervací — jen nadcházející (proběhlé se nezobrazují); propojené
    // se zveřejněnou akcí webu se ukážou jako ona
    let akce;
    if (probehle) {
      // akce propojená s běžící sérií má v databázi první termín — mezi proběhlé nepatří, dokud série běží
      const bezici = new Set((await s.kalendar.akce()).filter((e) => e.opakovani).map((e) => e.ref));
      akce = (await s.obsah.akce({ probehle, limit: 100 })).filter(
        (a) => !a.rezervace_ref || !bezici.has(a.rezervace_ref),
      );
    } else akce = await nadchazejiciAkce(100);
    return reply.view('web/akce', { titulek: t('web.akce'), akce, probehle, obr, ...pomocnici });
  });

  app.get<{ Params: { slug: string } }>('/akce/:slug', async (req, reply) => {
    const o = await s.obsah.podleSlugu('akce', req.params.slug);
    if (!o) return reply.callNotFound();
    // akce propojená se sérií v rezervacích: nejbližší termín a opakování z rezervací
    const serie = o.rezervace_ref?.startsWith('s')
      ? (await s.kalendar.akce()).find((e) => e.ref === o.rezervace_ref)
      : undefined;
    return detail(reply, o, { zpet: { url: '/akce', text: t('web.akce') }, serie });
  });

  app.get('/galerie', async (_req, reply) => {
    const galerie = await s.galerie.seznam({ verejne: true });
    return reply.view('web/galerie', { titulek: t('web.galerie'), galerie, ...pomocnici });
  });

  app.get<{ Params: { slug: string } }>('/galerie/:slug', async (req, reply) => {
    const g = await s.galerie.podleSlugu(req.params.slug);
    if (!g) return reply.callNotFound();
    const fotky = await s.galerie.fotky(g.id);
    return reply.view('web/galerie-detail', { titulek: g.nazev, g, fotky, ...pomocnici });
  });

  app.get('/videa', async (_req, reply) => {
    const videa = await s.videa.proZobrazeni(await s.videa.seznam({ verejne: true }));
    return reply.view('web/videa', { titulek: t('videa.titulek'), popis: t('videa.perex'), videa });
  });

  app.get('/dokumenty', async (_req, reply) => {
    const dokumenty = await s.dokumenty.seznam();
    const skupiny = [...new Set(dokumenty.map((d) => d.skupina))];
    return reply.view('web/dokumenty', { titulek: t('web.dokumenty'), dokumenty, skupiny, ...pomocnici });
  });

  app.get('/dotace', async (_req, reply) => {
    const dotace = await s.dotace.aktivni();
    return reply.view('web/dotace', { titulek: t('web.dotace'), dotace, ...pomocnici });
  });

  app.get<{ Params: { id: string } }>('/dotace/:id', async (req, reply) => {
    const d = (await s.dotace.aktivni()).find((x) => x.id === req.params.id);
    if (!d) return reply.callNotFound();
    return reply.view('web/dotace-detail', { titulek: d.projekt, d, ...pomocnici });
  });

  app.get<{ Querystring: { q?: string } }>('/hledat', async (req, reply) => {
    const q = String(req.query.q ?? '')
      .slice(0, 100)
      .trim();
    const vysledky: VysledekHledani[] = [];
    if (q) {
      const nalezene = await s.obsah.hledej(q);
      const adresy = await s.obsah.urlMnoha(nalezene);
      for (const [i, o] of nalezene.entries())
        vysledky.push({
          typ: t(`web.typ_${o.typ}`),
          titulek: o.titulek,
          url: adresy[i]!,
          text: o.perex || zkrat(textZHtml(o.obsah_html), 220),
          datum: o.typ === 'stranka' ? null : o.datum,
        });
      if (app.obec.moduly.deska) {
        const ted = new Date();
        const docs = [...(await app.deska.aktualni({ q })), ...(await app.deska.archiv({ q })).radky];
        for (const d of docs.slice(0, 20))
          vysledky.push({
            typ: d.sejmuto_do && d.sejmuto_do <= ted ? t('web.typ_deska_archiv') : t('deska.titulek'),
            titulek: d.nazev,
            url: `/uredni-deska/${d.id}`,
            text: zkrat(d.popis, 220),
            datum: d.vyveseno_od,
          });
      }
      const slova = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
      const shoda = (x: string) => {
        const n = x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        return slova.every((w) => n.includes(w));
      };
      for (const d of (await s.dokumenty.seznam())
        .filter((d) => shoda(`${d.nazev} ${d.popis} ${d.skupina}`))
        .slice(0, 10))
        vysledky.push({
          typ: t('web.dokumenty'),
          titulek: d.nazev,
          url: urlSouboru({ id: d.soubor_id, puvodni_nazev: d.puvodni_nazev }),
          text: d.popis,
          klic: klicVysledku({ url: '', souborId: d.soubor_id }),
        });
      // obsah dokumentů (text PDF, OCR, Word): sloučit s výsledky podle místa na webu, úryvek doplnit
      const podleKlice = new Map(vysledky.map((v) => [v.klic ?? klicVysledku(v), v]));
      for (const d of await vysledkyZDokumentu(app, s, q)) {
        const klic = d.klic ?? d.url;
        const existujici = podleKlice.get(klic);
        if (existujici) {
          existujici.uryvek ??= d.uryvek;
          continue;
        }
        podleKlice.set(klic, d);
        vysledky.push(d);
      }
    }
    return reply.view('web/hledat', {
      titulek: t('web.hledat'),
      q,
      vysledky,
      hledaDokumenty: app.env.TEXT_SOUBORU,
      noindex: true,
    });
  });

  // stránky webu a přesměrování starých adres (jen pro jinak neznámé adresy)
  app.zachytavace404.push(async (req, reply) => {
    const cesta = decodeURIComponent(req.url.split('?')[0] ?? '/');
    const segmenty = cesta.split('/').filter(Boolean);
    if (segmenty.length >= 1 && segmenty.length <= 2 && segmenty.every((x) => /^[a-z0-9-]+$/.test(x))) {
      const nalez = await s.obsah.strankaPodleCesty(segmenty);
      if (nalez) {
        if (nalez.kanonicka !== cesta.replace(/\/$/, '')) {
          reply.redirect(nalez.kanonicka, 301);
          return true;
        }
        const podstranky = await s.obsah.podstranky(nalez.o.id);
        const rodic = nalez.o.nadrazena_id ? await s.obsah.podleId(nalez.o.nadrazena_id) : undefined;
        const sourozenci = rodic ? await s.obsah.podstranky(rodic.id) : [];
        // odkaz, na který už text stránky sám odkazuje (např. karty služeb), se v dlaždicích neopakuje
        const [adresyPod, adresySour] = await Promise.all([
          s.obsah.urlMnoha(podstranky),
          s.obsah.urlMnoha(sourozenci),
        ]);
        const urlPod = podstranky
          .map((p, i) => ({ ...p, url: adresyPod[i]! }))
          .filter((p) => p.typ !== 'odkaz' || !nalez.o.obsah_html.includes(`href="${p.url}"`));
        const urlSour = sourozenci.map((p, i) => ({ ...p, url: adresySour[i]! }));
        await detail(reply, nalez.o, { podstranky: urlPod, rodic, sourozenci: urlSour, jeStranka: true });
        return true;
      }
    }
    const kam = await s.presmerovani.najdi(req.url);
    // i starší záznamy z doby před přísnější kontrolou: jen vlastní cesta nebo http(s)
    if (kam && jeBezpecnyOdkaz(kam)) {
      reply.redirect(kam, 301);
      return true;
    }
    return false;
  });
}

// fastify-plugin: app.webUvod musí být vidět i z rout jádra (titulní stránka /)
export default fp(webVerejne, { name: 'webVerejne' });
