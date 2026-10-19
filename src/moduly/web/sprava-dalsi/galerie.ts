// Správa webu — Fotogalerie: alba, nahrávání více fotek najednou, popisky a pořadí.
import type { FastifyInstance } from 'fastify';
import { datumPraha } from '../../../lib/datum.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden, vice, jeDatum } from './spolecne.js';

export default async function webSpravaGalerie(app: FastifyInstance, s: WebSluzby) {
  const { t, redaktor, ulozObrazky, pomocnici } = kontextSpravy(app);

  app.get('/sprava/web/galerie', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/galerie', {
      titulek: t('web.galerie'),
      galerie: await s.galerie.seznam({ verejne: false }),
      ...pomocnici,
    }),
  );

  app.post<{ Body: Telo }>('/sprava/web/galerie', { preHandler: redaktor }, async (req, reply) => {
    const nazev = jeden(req.body?.nazev).slice(0, 200);
    if (!nazev) {
      req.session.flash = { typ: 'chyba', text: t('web.chyba_titulek') };
      return reply.redirect('/sprava/web/galerie');
    }
    const datum = jeden(req.body?.datum);
    const id = await s.galerie.uloz(
      null,
      {
        nazev,
        popis: jeden(req.body?.popis).slice(0, 2000),
        datum: jeDatum(datum) ? datum : datumPraha(new Date()),
      },
      req.uzivatel!.id,
    );
    const { ids, chyby } = await ulozObrazky(
      req,
      'fotky',
      'obrazek',
      (_n, i) => `${nazev} — ${t('web.fotografie')} ${i}`,
    );
    await s.galerie.pridejFotky(id, ids);
    req.session.flash = chyby.length
      ? { typ: 'chyba', text: chyby.join(' ') }
      : { typ: 'ok', text: t('web.galerie_zalozena', { n: ids.length }) };
    return reply.redirect(`/sprava/web/galerie/${id}`);
  });

  app.get<{ Params: { id: string } }>(
    '/sprava/web/galerie/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const g = await s.galerie.podleId(req.params.id);
      if (!g) return reply.callNotFound();
      return reply.view('web/sprava/galerie-detail', {
        titulek: g.nazev,
        g,
        fotky: await s.galerie.fotky(g.id),
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Querystring: { foto?: string }; Body: Telo }>(
    '/sprava/web/galerie/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const g = await s.galerie.podleId(req.params.id);
      if (!g) return reply.callNotFound();
      const b = req.body ?? {};
      const akce = jeden(b.akce);
      if (akce === 'kos' || akce === 'obnovit') {
        await s.galerie.doKose(g.id, akce === 'kos', req.uzivatel!.id);
        req.session.flash = {
          typ: 'ok',
          text: akce === 'kos' ? t('web.v_kosi', { titulek: g.nazev }) : t('web.obnoveno'),
        };
        return reply.redirect(akce === 'kos' ? '/sprava/web/galerie' : `/sprava/web/galerie/${g.id}`);
      }
      const nazev = jeden(b.nazev).slice(0, 200) || g.nazev;
      const datum = jeden(b.datum);
      await s.galerie.uloz(
        g.id,
        { nazev, popis: jeden(b.popis).slice(0, 2000), datum: jeDatum(datum) ? datum : g.datum },
        req.uzivatel!.id,
      );
      // popisky a alternativní texty fotek
      const fotky = await s.galerie.fotky(g.id);
      let bezAlt = 0;
      for (const f of fotky) {
        const alt = b[`alt_${f.id}`];
        if (alt !== undefined) {
          const a = jeden(alt).slice(0, 300);
          await app.soubory.nastavAlt(f.id, a);
          if (!a) bezAlt++;
        } else if (!f.alt) bezAlt++;
        if (b[`popisek_${f.id}`] !== undefined)
          await s.galerie.nastavPopisek(g.id, f.id, jeden(b[`popisek_${f.id}`]).slice(0, 300));
      }
      await s.galerie.odeberFotky(g.id, vice(b.odebrat).map(String));
      const { ids, chyby } = await ulozObrazky(
        req,
        'fotky',
        'obrazek',
        (_n, i) => `${nazev} — ${t('web.fotografie')} ${fotky.length + i}`,
      );
      await s.galerie.pridejFotky(g.id, ids);
      if (akce === 'nahoru' || akce === 'dolu') {
        const foto = jeden(req.query.foto);
        await s.galerie.posunFotku(g.id, foto, akce);
        return reply.redirect(`/sprava/web/galerie/${g.id}#f-${foto}`);
      }
      if (akce === 'zverejnit' || akce === 'skryt') {
        if (akce === 'zverejnit' && bezAlt) {
          req.session.flash = { typ: 'chyba', text: t('web.chyba_alt', { n: bezAlt }) };
          return reply.redirect(`/sprava/web/galerie/${g.id}`);
        }
        await s.galerie.nastavStav(g.id, akce === 'zverejnit' ? 'zverejneno' : 'koncept', req.uzivatel!.id);
      }
      req.session.flash = chyby.length
        ? { typ: 'chyba', text: chyby.join(' ') }
        : akce === 'zverejnit'
          ? {
              typ: 'ok',
              text: t('web.galerie_zverejnena'),
              odkaz: { url: `/galerie/${(await s.galerie.podleId(g.id))!.slug}`, text: t('web.zobrazit') },
            }
          : {
              typ: 'ok',
              text: t('app.ulozeno') + (ids.length ? ' ' + t('web.fotek_pridano', { n: ids.length }) : ''),
            };
      return reply.redirect(`/sprava/web/galerie/${g.id}`);
    },
  );
}
