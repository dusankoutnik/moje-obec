// Mapa stránek: generuje se sama ze stromu stránek (menu i stránky mimo menu) a ze zapnutých modulů —
// po každé změně menu je aktuální, nic se neudržuje ručně.
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { DOPLNKY } from './doplnky.js';

export interface UzelMapy {
  titulek: string;
  url: string;
  deti: UzelMapy[];
}

interface Radek {
  id: string;
  typ: string;
  titulek: string;
  slug: string;
  nadrazena_id: string | null;
  odkaz_url: string;
  v_menu: boolean;
}

/** strom zveřejněných stránek a odkazů: nejdřív menu (v jeho pořadí), pak stránky mimo menu */
export function stromMapy(radky: Radek[]): { menu: UzelMapy[]; mimoMenu: UzelMapy[] } {
  const doplnky = new Set(Object.values(DOPLNKY));
  const url = (o: Radek, rodic?: Radek) =>
    o.typ === 'odkaz' ? o.odkaz_url || '/' : rodic ? `/${rodic.slug}/${o.slug}` : `/${o.slug}`;
  const koreny = radky.filter((o) => !o.nadrazena_id || !radky.some((r) => r.id === o.nadrazena_id));
  const uzel = (k: Radek): UzelMapy => ({
    titulek: k.titulek,
    url: url(k),
    deti: radky
      .filter((o) => o.nadrazena_id === k.id)
      .map((d) => ({ titulek: d.titulek, url: url(d, k), deti: [] })),
  });
  return {
    menu: koreny.filter((k) => k.v_menu).map(uzel),
    // odkazy mimo menu jsou jen technické položky (výchozí menu instalace) — do mapy nepatří; doplňky nativních
    // stránek se čtou jako součást nativní stránky
    mimoMenu: koreny
      .filter((k) => !k.v_menu && k.typ === 'stranka' && !doplnky.has(k.slug))
      .sort((a, b) => a.titulek.localeCompare(b.titulek, 'cs'))
      .map(uzel),
  };
}

/** položka sitemap.xml */
export interface PolozkaSitemap {
  url: string;
  lastmod?: Date | null;
}

export function sitemapXml(base: string, polozky: PolozkaSitemap[]): string {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const videne = new Set<string>();
  const radky = polozky
    .filter((p) => p.url.startsWith('/') && !videne.has(p.url) && videne.add(p.url))
    .map(
      (p) =>
        `<url><loc>${x(base + encodeURI(p.url))}</loc>${p.lastmod ? `<lastmod>${p.lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}</url>`,
    );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${radky.join('\n')}\n</urlset>\n`;
}

async function webMapa(app: FastifyInstance) {
  const t = app.t;

  // robots.txt instalace (vývojová instalace s ROBOTS_NOINDEX zakazuje vše; dev za NPM ho navíc přebíjí proxy)
  app.get('/robots.txt', async (_req, reply) => {
    const base = app.env.BASE_URL.replace(/\/$/, '');
    const text = app.env.ROBOTS_NOINDEX
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nDisallow: /sprava\nDisallow: /ucet\nDisallow: /prihlaseni\nDisallow: /oidc\nDisallow: /hledat\n\nSitemap: ${base}/sitemap.xml\n`;
    return reply.type('text/plain; charset=utf-8').send(text);
  });

  // sitemap.xml: zveřejněné stránky, aktuality, akce, galerie, aktuální úřední deska a stránky modulů
  app.get('/sitemap.xml', async (_req, reply) => {
    const ted = new Date();
    const doplnky = new Set(Object.values(DOPLNKY));
    const obsah = await app.db
      .selectFrom('web_obsah as o')
      .leftJoin('web_obsah as r', 'r.id', 'o.nadrazena_id')
      .select(['o.typ', 'o.slug', 'o.upraveno_at', 'o.datum', 'r.slug as rodic_slug', 'r.typ as rodic_typ'])
      .where('o.typ', 'in', ['stranka', 'aktualita', 'akce'])
      .where('o.stav', '=', 'zverejneno')
      .where('o.smazano_at', 'is', null)
      .orderBy('o.typ')
      .orderBy('o.poradi')
      .execute();
    const polozky: PolozkaSitemap[] = [{ url: '/' }];
    for (const o of obsah) {
      if (o.typ === 'aktualita' && o.datum && o.datum > ted) continue;
      if (o.typ === 'stranka' && doplnky.has(o.slug)) continue;
      const url =
        o.typ === 'aktualita'
          ? `/aktuality/${o.slug}`
          : o.typ === 'akce'
            ? `/akce/${o.slug}`
            : o.rodic_slug && o.rodic_typ === 'stranka'
              ? `/${o.rodic_slug}/${o.slug}`
              : `/${o.slug}`;
      polozky.push({ url, lastmod: o.upraveno_at });
    }
    const galerie = await app.db
      .selectFrom('web_galerie')
      .select(['slug', 'upraveno_at'])
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .execute();
    polozky.push(...galerie.map((g) => ({ url: `/galerie/${g.slug}`, lastmod: g.upraveno_at })));
    const m = app.obec.moduly;
    polozky.push(
      ...['/aktuality', '/akce', '/galerie', '/videa', '/dokumenty', '/dotace'].map((url) => ({ url })),
    );
    if (m.deska) {
      polozky.push({ url: '/uredni-deska' }, { url: '/rozpocet' }, { url: '/povinne-informace' });
      // jen právě vyvěšené dokumenty — sejmuté se do vyhledávačů nepropagují (archiv zůstává dohledatelný na webu)
      const deska = await app.deska.aktualni({}, ted);
      polozky.push(...deska.map((d) => ({ url: `/uredni-deska/${d.id}`, lastmod: d.upraveno_at })));
    }
    polozky.push(...(await app.web.dotace.aktivni()).map((d) => ({ url: `/dotace/${d.id}` })));
    if (m.odstavky) polozky.push({ url: '/odstavky' });
    if (m.infokanal) polozky.push({ url: '/infokanal' });
    if (m.kviz) polozky.push({ url: '/kviz' });
    polozky.push(
      { url: '/kontakt' },
      { url: app.obec.patika.ochrana_osobnich_udaju },
      { url: app.obec.patika.prohlaseni_o_pristupnosti },
      ...(app.obec.patika.zasady_cookies ? [{ url: app.obec.patika.zasady_cookies }] : []),
      { url: '/mapa-stranek' },
    );
    return reply
      .type('application/xml; charset=utf-8')
      .send(sitemapXml(app.env.BASE_URL.replace(/\/$/, ''), polozky));
  });

  app.get('/mapa-stranek', async (_req, reply) => {
    const radky = await app.db
      .selectFrom('web_obsah')
      .select(['id', 'typ', 'titulek', 'slug', 'nadrazena_id', 'odkaz_url', 'v_menu'])
      .where('typ', 'in', ['stranka', 'odkaz'])
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .orderBy('poradi')
      .orderBy('titulek')
      .execute();
    const { menu, mimoMenu } = stromMapy(radky);
    const m = app.obec.moduly;
    const sluzby: { titulek: string; url: string }[] = [
      { titulek: t('web.aktuality'), url: '/aktuality' },
      { titulek: t('web.akce'), url: '/akce' },
      { titulek: t('web.galerie'), url: '/galerie' },
      { titulek: t('web.dokumenty'), url: '/dokumenty' },
      { titulek: t('web.dotace'), url: '/dotace' },
      ...(m.deska
        ? [
            { titulek: t('deska.titulek'), url: '/uredni-deska' },
            { titulek: t('deska.archiv'), url: '/uredni-deska/archiv' },
            { titulek: t('deska.rozpocet_titulek'), url: '/rozpocet' },
            { titulek: t('pi.titulek'), url: '/povinne-informace' },
          ]
        : []),
      ...(m.infokanal ? [{ titulek: app.obec.texty.nazev_infokanalu, url: '/infokanal' }] : []),
      ...(m.podatelna ? [{ titulek: t('podatelna.titulek'), url: '/podatelna' }] : []),
      ...(m.kviz ? [{ titulek: t('kviz.titulek'), url: '/kviz' }] : []),
      ...(m.ucty ? [{ titulek: t('staticke.mapa_ucet'), url: '/ucet' }] : []),
      { titulek: t('staticke.kontakt_titulek'), url: '/kontakt' },
      { titulek: t('staticke.gdpr_titulek'), url: app.obec.patika.ochrana_osobnich_udaju },
      { titulek: t('staticke.pristupnost_titulek'), url: app.obec.patika.prohlaseni_o_pristupnosti },
      { titulek: t('web.hledat'), url: '/hledat' },
    ];
    return reply.view('web/mapa', { titulek: t('staticke.mapa_titulek'), menu, mimoMenu, sluzby });
  });
}

export default fp(webMapa, { name: 'webMapa' });
