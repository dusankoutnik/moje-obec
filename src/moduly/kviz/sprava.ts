// Správa kvízu (role kviz nebo web, admin vše): přehled kategorií a otázek s úspěšností hráčů,
// vypnutí/zapnutí otázky, nové načtení balíků. Texty otázek se upravují v YAML balících, ne tady.
import type { FastifyInstance } from 'fastify';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { zapisAudit } from '../../lib/audit.js';
import type { KvizSluzba } from './sluzba.js';
import type { VysledekImportu } from './import.js';

export default async function kvizSprava(app: FastifyInstance, z: { sluzba: KvizSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const pravo = vyzadujRoli('kviz', 'web');

  app.get('/sprava/kviz', { preHandler: pravo }, async (_req, reply) => {
    const prehled = await sluzba.prehledSpravy();
    const imp = await app.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', 'kviz_import')
      .executeTakeFirst();
    return reply.view('kviz/sprava/index', {
      titulek: t('kviz.sprava_titulek'),
      ...prehled,
      posledniImport: (imp?.hodnota ?? null) as (VysledekImportu & { at: string }) | null,
    });
  });

  app.post('/sprava/kviz/import', { preHandler: pravo }, async (req, reply) => {
    const v = await app.kvizImport();
    await zapisAudit(app.db, {
      uzivatelId: req.uzivatel!.id,
      akce: 'kviz.import',
      detail: {
        otazky: v.otazky,
        nove: v.nove,
        zmenene: v.zmenene,
        deaktivovane: v.deaktivovane,
        chyby: v.chyby.length,
      },
      ip: req.ip,
    });
    req.session.flash = v.chyby.length
      ? { typ: 'chyba', text: t('kviz.import_chyby', { n: v.chyby.length }) }
      : { typ: 'ok', text: t('kviz.import_hotovo', { n: v.otazky, nove: v.nove, zmenene: v.zmenene }) };
    return reply.redirect('/sprava/kviz', 303);
  });

  app.get<{ Params: { slug: string } }>('/sprava/kviz/:slug', { preHandler: pravo }, async (req, reply) => {
    const d = await sluzba.otazkySpravy(req.params.slug);
    if (!d) return reply.callNotFound();
    return reply.view('kviz/sprava/kategorie', { titulek: d.kategorie.nazev, ...d });
  });

  app.post<{ Params: { id: string }; Body: { akce?: string } }>(
    '/sprava/kviz/otazka/:id',
    { preHandler: pravo },
    async (req, reply) => {
      const zapnout = req.body?.akce === 'zapnout';
      const slug = await sluzba.prepniOtazku(req.params.id, zapnout, req.uzivatel!, req.ip);
      if (!slug) return reply.callNotFound();
      req.session.flash = {
        typ: 'ok',
        text: t(zapnout ? 'kviz.otazka_zapnuta' : 'kviz.otazka_vypnuta', { id: req.params.id }),
      };
      return reply.redirect(`/sprava/kviz/${slug}#o-${encodeURIComponent(req.params.id)}`, 303);
    },
  );
}
