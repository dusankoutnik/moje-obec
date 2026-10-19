// Základní stránky: úvod, healthz, povinné statické stránky (přístupnost, GDPR, kontakt).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { nactiDoplnek, presmerovaniDoplnku } from '../moduly/web/doplnky.js';

export default async function webRoutes(app: FastifyInstance) {
  // titulní stránka: se zapnutým modulem „web“ obecní web, jinak rozcestník služeb platformy
  app.get('/', async (req, reply) => {
    if (app.obec.moduly.web && app.webUvod) return app.webUvod(req, reply);
    return sluzby(req, reply);
  });
  app.get('/sluzby', async (req, reply) => sluzby(req, reply));

  async function sluzby(req: FastifyRequest, reply: FastifyReply) {
    let odber: { overen: boolean } | null = null;
    if (req.uzivatel && app.obec.moduly.infokanal) {
      const o = await app.db
        .selectFrom('ik_odberatele')
        .select(['overen_at', 'odhlasen_at'])
        .where('telefon', '=', req.uzivatel.telefon)
        .executeTakeFirst();
      if (o) odber = { overen: !!o.overen_at && !o.odhlasen_at };
    }
    return reply.view('uvod', { titulek: app.t('uvod.titulek'), odber });
  }

  // Živost + připojení k DB. Vrací 503, když databáze neodpovídá — pro Docker healthcheck i monitoring.
  // Detail chyby (adresa a port databáze) jde jen do logu, ne anonymnímu klientovi.
  app.get('/healthz', async (req, reply) => {
    try {
      await sql`select 1`.execute(app.db);
      return reply.send({
        stav: 'ok',
        verze: process.env.npm_package_version ?? '0.1.0',
        cas: new Date().toISOString(),
      });
    } catch (e) {
      req.log.error({ err: e }, 'healthz: databáze neodpovídá');
      return reply.code(503).send({ stav: 'chyba' });
    }
  });

  // povinné stránky z profilu obce; s modulem „web“ k nim obec může připsat vlastní text (moduly/web/doplnky.ts)
  const doplnek = (cesta: string) => (app.obec.moduly.web ? nactiDoplnek(app.db, cesta) : null);
  if (app.obec.moduly.web) await presmerovaniDoplnku(app);
  app.get('/prohlaseni-o-pristupnosti', async (_req, reply) =>
    reply.view('staticke/pristupnost', {
      titulek: app.t('staticke.pristupnost_titulek'),
      baseUrl: app.env.BASE_URL.replace(/\/$/, ''),
      doplnek: await doplnek('/prohlaseni-o-pristupnosti'),
    }),
  );
  app.get('/ochrana-osobnich-udaju', async (_req, reply) =>
    reply.view('staticke/gdpr', {
      titulek: app.t('staticke.gdpr_titulek'),
      doplnek: await doplnek('/ochrana-osobnich-udaju'),
    }),
  );
  app.get('/kontakt', async (_req, reply) =>
    reply.view('staticke/kontakt', {
      titulek: app.t('staticke.kontakt_titulek'),
      doplnek: await doplnek('/kontakt'),
    }),
  );
}
