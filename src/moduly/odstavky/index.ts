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
      banner: !!app.obec.odstavky.cez.banner,
      userAgent: `Web od Voltu 2.0 (${app.env.BASE_URL})`,
    },
    app.log,
  );
  app.decorate('odstavky', sluzba);

  // Obrázkový banner ČEZ: stáhne ho server (keš 1 h, při chybě poslední známý), návštěvník nic od ČEZ nenačítá.
  // Jen když je nějaká aktuální odstávka — jinak 404 a šablona ho nevykreslí.
  const bannerUrl = app.obec.odstavky.cez.banner;
  let bannerKes: { data: Buffer; typ: string; at: number } | null = null;
  app.get('/odstavky/banner.png', async (_req, reply) => {
    if (!bannerUrl) return reply.code(404).send();
    const stav = await sluzba.stav();
    if (!stav.aktualni.some((o) => !o.zruseno)) return reply.code(404).send();
    if (!bannerKes || Date.now() - bannerKes.at > 3600_000) {
      try {
        const r = await fetch(bannerUrl, {
          headers: { 'user-agent': `Web od Voltu 2.0 (${app.env.BASE_URL})` },
          signal: AbortSignal.timeout(10_000),
        });
        const typ = r.headers.get('content-type') ?? '';
        const data = Buffer.from(await r.arrayBuffer());
        if (r.ok && /^image\/(png|jpeg|webp|gif)/.test(typ) && data.length < 1_000_000)
          bannerKes = { data, typ, at: Date.now() };
        else app.log.warn({ status: r.status, typ }, 'banner ČEZ: neočekávaná odpověď');
      } catch (e) {
        app.log.warn({ err: e }, 'banner ČEZ: stažení selhalo');
      }
    }
    if (!bannerKes) return reply.code(404).send();
    return reply.header('cache-control', 'public, max-age=900').type(bannerKes.typ).send(bannerKes.data);
  });

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
