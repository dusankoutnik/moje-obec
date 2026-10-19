// Správa webu — Přesměrování starých adres.
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../../../lib/audit.js';
import { PresmerovaniSluzba } from '../dalsi.js';
import { jeBezpecnyOdkaz } from '../../../lib/navrat.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden } from './spolecne.js';

export default async function webSpravaPresmerovani(app: FastifyInstance, s: WebSluzby) {
  const { t, spravce } = kontextSpravy(app);

  // ---------- přesměrování starých adres ----------
  app.get('/sprava/web/presmerovani', { preHandler: spravce }, async (_req, reply) =>
    reply.view('web/sprava/presmerovani', {
      titulek: t('web.presmerovani'),
      seznam: await s.presmerovani.seznam(),
    }),
  );
  app.post<{ Body: Telo }>('/sprava/web/presmerovani', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    if (jeden(b.akce) === 'smazat') await s.presmerovani.smaz(jeden(b.stara));
    else {
      const nova = jeden(b.nova);
      if (jeden(b.stara) && jeBezpecnyOdkaz(nova)) {
        const r = await s.presmerovani.pridej(jeden(b.stara), nova);
        if (r !== 'ulozeno') req.session.flash = { typ: 'chyba', text: t(`web.chyba_presmerovani_${r}`) };
      } else req.session.flash = { typ: 'chyba', text: t('web.chyba_presmerovani') };
    }
    await zapisAudit(app.db, {
      uzivatelId: req.uzivatel!.id,
      akce: 'web.presmerovani',
      detail: { stara: PresmerovaniSluzba.normalizuj(jeden(b.stara)) },
      ip: req.ip,
    });
    return reply.redirect('/sprava/web/presmerovani');
  });
}
