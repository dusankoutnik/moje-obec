// Modul „odstavky“: plánované odstávky elektřiny ČEZ Distribuce na titulce webu a na stránce /odstavky — jako
// přístupný text místo obrázkového banneru z cizího serveru (prohlížeč návštěvníka nic od ČEZ nenačítá; data stahuje
// server zřídka a drží je v keši). Obec mimo území ČEZ Distribuce (EG.D, PREdistribuce) modul nezapíná.
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { OdstavkySluzba } from './sluzba.js';
import { CEZ_WEB, datumOdstavky, pocetMist, popisUlice, souhrnMist, terminOdstavky } from './cez.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** jen když je modul zapnutý (moduly.odstavky a známý kód obce) */
    odstavky?: OdstavkySluzba;
  }
}

/** pomocníci pro šablony odstávek */
export const pomocniciOdstavek = { terminOdstavky, datumOdstavky, souhrnMist, popisUlice, pocetMist };

async function odstavkyModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const kodObce = app.obec.odstavky.cez.kod_obce || app.obec.obec.kod_obce;
  if (!/^\d+$/.test(kodObce)) {
    app.log.warn('modul odstavky: chybí kód obce (odstavky.cez.kod_obce ani obec.kod_obce) — vypnuto');
    return;
  }
  const sluzba = new OdstavkySluzba(
    app.db,
    {
      kodObce,
      odkazCez: app.obec.odstavky.cez.odkaz || CEZ_WEB,
      userAgent: `Moje obec 2.0 (${app.env.BASE_URL})`,
    },
    app.log,
  );
  app.decorate('odstavky', sluzba);

  app.get('/odstavky', async (_req, reply) => {
    return reply.view('odstavky/index', {
      titulek: app.t('odstavky.titulek'),
      odstavky: await sluzba.stav(),
      ...pomocniciOdstavek,
    });
  });

  if (volby.planovac) {
    // jednou za hodinu (API je neoficiální a při rychlých dotazech vrací 429); po startu jen když jsou data stará
    const obnov = () => sluzba.obnov().catch((e) => app.log.warn({ err: e }, 'odstávky ČEZ: obnova selhala'));
    const job = new Cron('11 * * * *', { timezone: 'Europe/Prague' }, obnov);
    const start = setTimeout(obnov, 20_000);
    app.addHook('onClose', async () => {
      job.stop();
      clearTimeout(start);
    });
  }
}

export default fp(odstavkyModul, { name: 'odstavkyModul' });
