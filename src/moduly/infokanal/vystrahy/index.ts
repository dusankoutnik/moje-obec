// Modul automatických výstrah infokanálu (ČHMÚ, ČEZ, SčVK). Registruje se za infokanálem (a za modulem odstavky,
// jehož data ČEZ znovu používá). Veřejná stránka /infokanal/vystrahy, správa /infokanal/sprava/vystrahy.
// Plánovač jen když env VYSTRAHY není 0 a zdroj je v obec.yml (vystrahy.chmu / cez / scvk).
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { vyzadujRoli } from '../../ucty/opravneni.js';
import { CEZ_WEB } from '../../odstavky/cez.js';
import { OdstavkySluzba } from '../../odstavky/sluzba.js';
import { VystrahySluzba } from './sluzba.js';

declare module 'fastify' {
  interface FastifyInstance {
    vystrahy: VystrahySluzba;
  }
}

async function vystrahyModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const k = app.obec.vystrahy;
  const ua = `Web od Voltu 2.0 (${app.env.BASE_URL})`;
  // ČEZ: stejná data (a stejná keš) jako modul odstavky; když modul odstavky není zapnutý, vlastní instance
  // nad stejným uložením (dotazy jen v časech kontroly výstrah)
  let odstavky: OdstavkySluzba | null = null;
  if (k.cez) {
    const kodObce = k.cez.kod_obce || app.obec.odstavky.cez.kod_obce || app.obec.obec.kod_obce;
    if (app.odstavky) odstavky = app.odstavky;
    else if (/^\d+$/.test(kodObce))
      odstavky = new OdstavkySluzba(
        app.db,
        { kodObce, odkazCez: app.obec.odstavky.cez.odkaz || CEZ_WEB, userAgent: ua },
        app.log,
      );
    else app.log.warn('výstrahy ČEZ: chybí kód obce — vypnuto');
  }
  const orp = k.chmu ? k.chmu.orp || app.obec.obec.orp_cisorp : '';
  if (k.chmu && !orp)
    app.log.warn('výstrahy ČHMÚ: chybí kód ORP (vystrahy.chmu.orp ani obec.orp_cisorp) — vypnuto');
  const obecNazev = app.obec.obec.kratky_nazev || app.obec.obec.nazev;
  const sluzba = new VystrahySluzba(
    app.db,
    app.infokanal,
    app.mail,
    {
      baseUrl: app.env.BASE_URL,
      obec: obecNazev,
      casti: app.obec.obec.casti,
      nazevKanalu: app.obec.texty.nazev_infokanalu,
      oblast: k.chmu?.oblast || `ORP ${orp}`,
      chmuOrp: orp,
      scvkObec: k.scvk ? k.scvk.obec || obecNazev : '',
      notify: app.env.VYSTRAHY_NOTIFY.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      userAgent: ua,
    },
    app.log,
    odstavky,
    () => app.infokanalFronta.kopni(),
  );
  app.decorate('vystrahy', sluzba);
  const t = app.t;

  app.get('/infokanal/vystrahy', async (_req, reply) => {
    return reply.view('infokanal/vystrahy', {
      titulek: t('vystrahy.titulek'),
      vystrahy: await sluzba.verejnySeznam(),
    });
  });

  const redaktor = vyzadujRoli('redaktor');
  app.get('/infokanal/sprava/vystrahy', { preHandler: redaktor }, async (_req, reply) => {
    return reply.view('infokanal/sprava/vystrahy', {
      titulek: t('vystrahy.sprava'),
      vystrahy: await sluzba.seznamSpravy(),
      zdroje: await sluzba.stavZdroju(),
      zapnute: app.env.VYSTRAHY ? sluzba.zapnuteZdroje : [],
    });
  });

  app.get<{ Params: { id: string } }>(
    '/infokanal/sprava/vystrahy/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const id = Number(req.params.id);
      const v = Number.isInteger(id) && id > 0 ? await sluzba.detail(id) : null;
      if (!v) return reply.callNotFound();
      return reply.view('infokanal/sprava/vystraha', { titulek: v.titulek, v });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/infokanal/sprava/vystrahy/:id/rozeslat',
    { preHandler: redaktor },
    async (req, reply) => {
      const id = Number(req.params.id);
      const r =
        Number.isInteger(id) && id > 0
          ? await sluzba.rozeslat(id, req.uzivatel!.id)
          : { chyba: 'vyrizeno' as const };
      if ('chyba' in r) {
        req.session.flash = { typ: 'chyba', text: t(`vystrahy.chyba_${r.chyba}`) };
        return reply.redirect(`/infokanal/sprava/vystrahy/${id}`);
      }
      req.session.flash = { typ: 'ok', text: t('vystrahy.rozeslano') };
      return reply.redirect(`/infokanal/sprava/hlaseni/${r.hlaseniId}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/infokanal/sprava/vystrahy/:id/zahodit',
    { preHandler: redaktor },
    async (req, reply) => {
      const id = Number(req.params.id);
      const ok = Number.isInteger(id) && id > 0 && (await sluzba.zahodit(id, req.uzivatel!.id));
      req.session.flash = ok
        ? { typ: 'info', text: t('vystrahy.zahozeno') }
        : { typ: 'chyba', text: t('vystrahy.chyba_vyrizeno') };
      return reply.redirect(`/infokanal/sprava/vystrahy/${id}`);
    },
  );

  if (volby.planovac && app.env.VYSTRAHY) {
    const zdroje = sluzba.zapnuteZdroje;
    const opts = { timezone: 'Europe/Prague', protect: true };
    const loguj = async (p: Promise<unknown>) => {
      await p.catch((e: unknown) => app.log.warn({ err: e }, 'výstrahy: plánovač'));
    };
    const joby: Cron[] = [];
    if (zdroje.includes('chmu'))
      joby.push(new Cron('*/10 * * * *', opts, () => loguj(sluzba.zkontrolujChmu())));
    if (zdroje.includes('cez')) {
      joby.push(new Cron('5 7,15 * * *', opts, () => loguj(sluzba.zkontrolujCez())));
      joby.push(new Cron('0 17 * * *', opts, () => loguj(sluzba.pripomenCez())));
    }
    if (zdroje.includes('scvk')) {
      joby.push(new Cron('7,27,47 * * * *', opts, () => loguj(sluzba.zkontrolujScvk())));
      joby.push(new Cron('2 17 * * *', opts, () => loguj(sluzba.pripomenScvk())));
    }
    app.log.info({ zdroje }, 'výstrahy: plánovač zapnut');
    app.addHook('onClose', async () => joby.forEach((j) => j.stop()));
  }
}

export default fp(vystrahyModul, { name: 'vystrahyModul', dependencies: ['infokanalModul'] });
