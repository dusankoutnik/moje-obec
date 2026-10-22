// Úřední administrace ve Správě (náhrada centrální Administrace MujÚčtu, 22. 10. 2026):
//   dlaždice aplikací na /sprava (živé počty z rezervací), /sprava/schvalovani (žádosti z rezervací + účty
//   k posouzení rezidenta a bez jména), /sprava/statistiky (agregáty bez jmen), avíza správcům o nových účtech.
// Rezervace a eKnihy volá po vnitřní síti (APLIKACE_*_URL) s x-api-secret; nedostupná aplikace = bez čísla.
import { Cron } from 'croner';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Uzivatel } from '../../db/types.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { maRoli } from '../ucty/sluzba.js';
import { AplikaceKlient, RezervaceAdmin, type SouhrnRezervaci, type StatistikyEknih } from './aplikace.js';
import { AdministraceSluzba } from './sluzba.js';

declare module 'fastify' {
  interface FastifyInstance {
    administrace: {
      sluzba: AdministraceSluzba;
      rezervace: RezervaceAdmin;
      eknihy: AplikaceKlient;
      /** data dlaždic aplikací na dashboard Správy podle rolí (null = nic k zobrazení) */
      dlazdice(u: Uzivatel): Promise<DlazdiceSpravy | null>;
    };
  }
}

export interface DlazdiceSpravy {
  /** správce/admin: vše; účetní: finance */
  spravce: boolean;
  ucetni: boolean;
  /** jsou rezervace na instalaci (adresa + zapnutý modul)? */
  rezervace: boolean;
  predprodej: boolean;
  spolujizda: boolean;
  /** souhrn z /api/admin/summary, null = aplikace neodpověděla */
  souhrn: SouhrnRezervaci | null;
  /** nativní agenda účtů (jen správce) */
  ucty: { kPosouzeni: number; bezJmena: number } | null;
}

function kc(n: number) {
  return `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
}

async function administraceModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const tajemstvi = app.env.APLIKACE_API_SECRET || app.env.INTERNI_API_SECRET;
  const rezervace = new RezervaceAdmin(new AplikaceKlient(app.env.APLIKACE_REZERVACE_URL, tajemstvi));
  const eknihy = new AplikaceKlient(app.env.APLIKACE_EKNIHY_URL, tajemstvi);

  const posli = async (prijemci: string[], predmet: string, text: string) => {
    if (!prijemci.length) return;
    // přes odchozí frontu infokanálu (opakování při výpadku SMTP); bez infokanálu přímo poštou
    if (app.hasDecorator('infokanalOdchozi')) {
      const v = await app.infokanalOdchozi.zarad({
        prijemci: prijemci.map((email) => ({ email })),
        email: { predmet, text },
        zdroj: 'sprava',
      });
      if ('chyba' in v) app.log.warn({ chyba: v.chyba }, 'avízo správcům: nezařazeno');
      return;
    }
    for (const komu of prijemci) await app.mail.posli({ komu, predmet, text });
  };
  const sluzba = new AdministraceSluzba(app.db, app.ucty, posli, {
    baseUrl: app.env.BASE_URL,
    nazevObce: app.obec.obec.kratky_nazev,
  });

  const rezervaceZapnute = async () =>
    rezervace.klient.nastavena && app.moduly.dostupny('rezervace') && (await app.moduly.zapnuto('rezervace'));

  app.decorate('administrace', {
    sluzba,
    rezervace,
    eknihy,
    async dlazdice(u: Uzivatel): Promise<DlazdiceSpravy | null> {
      const spravce = maRoli(u, 'spravce');
      const ucetni = maRoli(u, 'ucetni');
      const rez = (spravce || ucetni) && (await rezervaceZapnute());
      if (!spravce && !rez) return null;
      return {
        spravce,
        ucetni,
        rezervace: !!rez,
        predprodej: !!rez && (await app.moduly.zapnuto('predprodej')),
        spolujizda: !!rez && (await app.moduly.zapnuto('spolujizda')),
        souhrn: rez ? await rezervace.souhrn() : null,
        ucty: spravce ? await sluzba.pocty() : null,
      };
    },
  });

  const spravce = vyzadujRoli('spravce');
  const t = app.t;

  // ---- Schvalování ----
  app.get('/sprava/schvalovani', { preHandler: spravce }, async (req, reply) => {
    const rez = await rezervaceZapnute();
    const zadosti = rez ? await rezervace.schvalovani() : null;
    return reply.view('sprava/schvalovani', {
      titulek: 'Schvalování',
      rezervaceZapnute: rez,
      zadosti,
      jeAdmin: maRoli(req.uzivatel, 'admin'),
      kPosouzeni: await sluzba.kPosouzeni(),
      bezJmena: await sluzba.bezJmena(),
    });
  });

  const zpet = (req: { session: { flash?: unknown } }, typ: 'ok' | 'chyba', text: string) => {
    req.session.flash = { typ, text };
  };

  app.post<{ Params: { id: string }; Body: { akce?: string; pozn?: string; cela_serie?: string } }>(
    '/sprava/schvalovani/rezervace/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const id = Number(req.params.id);
      const akce =
        req.body?.akce === 'potvrdit' ? 'potvrdit' : req.body?.akce === 'zamitnout' ? 'zamitnout' : null;
      if (!Number.isInteger(id) || id <= 0 || !akce) return reply.code(400).send();
      const out = await rezervace.vyridRezervaci(id, {
        akce,
        pozn: String(req.body?.pozn ?? '').slice(0, 200),
        celaSerie: req.body?.cela_serie === '1',
        cislo: req.uzivatel!.cislo,
      });
      if (out.ok)
        zpet(
          req,
          'ok',
          akce === 'potvrdit'
            ? 'Rezervace potvrzena, žadateli odešla zpráva.'
            : 'Rezervace zamítnuta, žadateli odešla zpráva.',
        );
      else
        zpet(
          req,
          'chyba',
          out.chyba || 'Vyřízení se nepovedlo (rezervace nedostupné, nebo žádost už vyřídil někdo jiný).',
        );
      return reply.redirect('/sprava/schvalovani');
    },
  );

  app.post<{ Params: { uid: string } }>(
    '/sprava/schvalovani/posilovna/:uid',
    { preHandler: vyzadujRoli('admin') },
    async (req, reply) => {
      const uid = Number(req.params.uid);
      if (!Number.isInteger(uid) || uid <= 0) return reply.code(400).send();
      const out = await rezervace.aktivujPosilovnu(uid, req.uzivatel!.cislo);
      if (out.ok) zpet(req, 'ok', 'Posilovna aktivována, uživateli odešly instrukce.');
      else
        zpet(
          req,
          'chyba',
          out.chyba || 'Aktivace se nepovedla (rezervace nedostupné, nebo žádost už není čekající).',
        );
      return reply.redirect('/sprava/schvalovani');
    },
  );

  app.post<{ Params: { id: string }; Body: { rezident?: string } }>(
    '/sprava/schvalovani/rezident/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const cil = await app.ucty.podleId(req.params.id).catch(() => undefined);
      if (!cil) return reply.callNotFound();
      const ano = req.body?.rezident === '1';
      await sluzba.posoudit(cil, ano, req.uzivatel!, req.ip);
      zpet(req, 'ok', ano ? 'Nastaveno: rezident.' : 'Posouzeno — není rezident.');
      return reply.redirect('/sprava/schvalovani');
    },
  );

  app.post<{ Params: { id: string }; Body: { jmeno?: string; prijmeni?: string } }>(
    '/sprava/schvalovani/jmeno/:id',
    { preHandler: spravce },
    async (req, reply) => {
      const cil = await app.ucty.podleId(req.params.id).catch(() => undefined);
      if (!cil) return reply.callNotFound();
      const r = await sluzba.nastavJmeno(
        cil,
        String(req.body?.jmeno ?? ''),
        String(req.body?.prijmeni ?? ''),
        req.uzivatel!,
        req.ip,
      );
      zpet(req, r.ok ? 'ok' : 'chyba', r.ok ? t('app.ulozeno') : 'Vyplňte jméno i příjmení.');
      return reply.redirect('/sprava/schvalovani');
    },
  );

  // ---- Statistiky ----
  app.get('/sprava/statistiky', { preHandler: spravce }, async (_req, reply) => {
    const rez = await rezervaceZapnute();
    const ekn = eknihy.nastavena && app.moduly.dostupny('eknihy') && (await app.moduly.zapnuto('eknihy'));
    const infokanal = app.obec.moduly.infokanal && app.hasDecorator('infokanal');
    const [zakladni, ik, souhrn, statEknih] = await Promise.all([
      sluzba.statistiky(),
      infokanal ? sluzba.statistikyInfokanalu() : Promise.resolve(null),
      rez ? rezervace.souhrn() : Promise.resolve(null),
      ekn ? eknihy.get<StatistikyEknih>('/api/statistiky') : Promise.resolve(null),
    ]);
    return reply.view('sprava/statistiky', {
      titulek: 'Statistiky',
      ucty: zakladni.ucty,
      infokanal: ik,
      infokanalNazev: app.obec.texty.nazev_infokanalu,
      rezervaceZapnute: rez,
      rezervace: souhrn,
      eknihyZapnute: ekn,
      eknihy: statEknih,
      kc,
    });
  });

  if (volby.planovac && app.env.REZIDENT_AVIZO) {
    const avizo = async () => {
      await sluzba
        .avizoNovychUctu()
        .catch((e: unknown) => app.log.warn({ err: e }, 'avízo rezidenta selhalo'));
    };
    const job = new Cron('*/5 * * * *', { timezone: 'Europe/Prague' }, avizo);
    app.addHook('onClose', async () => {
      job.stop();
    });
  }
}

export default fp(administraceModul, { name: 'administrace' });
