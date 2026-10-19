// Správa webu — Kategorie aktualit.
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../../../lib/audit.js';
import { slugify } from '../../../lib/slug.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden } from './spolecne.js';

export default async function webSpravaKategorie(app: FastifyInstance, s: WebSluzby) {
  const { t, spravce } = kontextSpravy(app);

  // ---------- kategorie aktualit ----------
  app.get('/sprava/web/kategorie', { preHandler: spravce }, async (_req, reply) =>
    reply.view('web/sprava/kategorie', {
      titulek: t('web.kategorie_aktualit'),
      kategorie: await s.obsah.kategorie(),
    }),
  );
  app.post<{ Body: Telo }>('/sprava/web/kategorie', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    const nazev = jeden(b.nazev).slice(0, 100);
    const id = Number(jeden(b.id)) || null;
    if (nazev) {
      if (id)
        await app.db
          .updateTable('web_kategorie')
          .set({ nazev, poradi: Number(jeden(b.poradi)) || 100 })
          .where('id', '=', id)
          .execute();
      else
        await app.db
          .insertInto('web_kategorie')
          .values({ nazev, slug: slugify(nazev, 40), poradi: Number(jeden(b.poradi)) || 100 })
          .onConflict((oc) => oc.column('slug').doNothing())
          .execute();
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'web.kategorie',
        detail: { id, nazev },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
    }
    return reply.redirect('/sprava/web/kategorie');
  });
}
