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

/** akce webu + akce z rezervací, seřazené podle začátku */
function sloucAkce<T extends { datum: Date | null }, U extends { datum: Date }>(
  web: T[],
  externi: U[],
): (T | U)[] {
  return [...web, ...externi].sort((a, b) => (a.datum?.getTime() ?? 0) - (b.datum?.getTime() ?? 0));
}

async function webVerejne(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;
  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, zkrat, textZHtml, odkazAkce };
  const obr = (id: string | null, nazev: string | null | undefined, nahled = true) =>
    id ? urlSouboru({ id, puvodni_nazev: nazev ?? 'obrazek.jpg' }, nahled) : '';

  app.decorate('webUvod', async (_req: FastifyRequest, reply: FastifyReply) => {
    const [aktuality, akceWebu, externi, dotace, videaTitulky, videaCelkem] = await Promise.all([
      s.obsah.aktuality({ naStranku: 4 }),
      s.obsah.akce({ limit: 3 }),
      s.kalendar.akce(),
      s.dotace.aktivni(),
      s.videa.seznam({ verejne: true, naTitulce: true, limit: 4 }),
      s.videa.pocetVerejnych(),
    ]);
    const videa = await s.videa.proZobrazeni(videaTitulky);
    const akce = sloucAkce(akceWebu, externi).slice(0, 3);
    const vsechnaDeska = app.obec.moduly.deska ? await app.deska.aktualni() : [];
    const deska = vsechnaDeska.slice(0, 5);
    // živé statistiky do úvodu — jen agregáty, žádná jména
    const statistiky: { hodnota: string; cislo?: number; popisek: string; odkaz?: string }[] = [];
    for (const f of app.obec.obec.fakta.slice(0, 3)) {
      const c = /^\d+$/.test(f.hodnota) ? Number(f.hodnota) : undefined;
      statistiky.push({ hodnota: f.hodnota, cislo: c, popisek: f.popisek });
    }
    if (app.obec.moduly.deska)
      statistiky.push({
        hodnota: String(vsechnaDeska.length),
        cislo: vsechnaDeska.length,
        popisek: t('web.stat_deska'),
        odkaz: '/uredni-deska',
      });
    if (app.obec.moduly.infokanal) {
      const n = (await app.infokanal.statistiky()).celkem;
      if (n > 0)
        statistiky.push({
          hodnota: String(n),
          cislo: n,
          popisek: t('web.stat_odberatele'),
          odkaz: '/infokanal',
        });
    }
    const pred30 = new Date(Date.now() - 30 * 86_400_000);
    const noveAktuality = await app.db
      .selectFrom('web_obsah')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('typ', '=', 'aktualita')
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .where('datum', '>=', pred30)
      .where('datum', '<=', new Date())
      .executeTakeFirstOrThrow();
    statistiky.push({
      hodnota: String(Number(noveAktuality.n)),
      cislo: Number(noveAktuality.n),
      popisek: t('web.stat_aktuality'),
      odkaz: '/aktuality',
    });
    if (akce[0]?.datum)
      statistiky.push({
        hodnota: akce[0].datum.toLocaleDateString('cs-CZ', {
          day: 'numeric',
          month: 'numeric',
          timeZone: 'Europe/Prague',
        }),
        popisek: t('web.stat_akce', { nazev: zkrat(akce[0].titulek, 40) }),
        odkaz: odkazAkce(akce[0]) ?? '/akce',
      });
    return reply.view('web/uvod', {
      titulek: '',
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
    const kategorie = await s.obsah.kategorie();
    const k = kategorie.find((x) => x.slug === req.query.kategorie);
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
          `<item><title>${x(a.titulek)}</title><link>${base}/aktuality/${a.slug}</link><guid isPermaLink="false">${a.id}</guid>${a.datum ? `<pubDate>${a.datum.toUTCString()}</pubDate>` : ''}<description>${x(a.perex)}</description></item>`,
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
    const akceWebu = await s.obsah.akce({ probehle, limit: 100 });
    // akce sálu, hřišť a předprodeje z rezervací — jen nadcházející (proběhlé se nezobrazují)
    const akce = probehle ? akceWebu : sloucAkce(akceWebu, await s.kalendar.akce());
    return reply.view('web/akce', { titulek: t('web.akce'), akce, probehle, obr, ...pomocnici });
  });

  app.get<{ Params: { slug: string } }>('/akce/:slug', async (req, reply) => {
    const o = await s.obsah.podleSlugu('akce', req.params.slug);
    if (!o) return reply.callNotFound();
    return detail(reply, o, { zpet: { url: '/akce', text: t('web.akce') } });
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
    const vysledky: { typ: string; titulek: string; url: string; text: string; datum?: Date | null }[] = [];
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
        });
    }
    return reply.view('web/hledat', { titulek: t('web.hledat'), q, vysledky, noindex: true });
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
