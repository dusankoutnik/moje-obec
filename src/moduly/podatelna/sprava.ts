// Správa elektronické podatelny (jen správce obce a admin — podání obsahují osobní údaje):
// seznam podání, detail, označení vyřízeno s interní poznámkou. Nic se nemaže — ani po uplynutí doby uchování
// (vyřazení řeší úřad ve skartačním řízení podle spisového a skartačního plánu).
import type { FastifyInstance } from 'fastify';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { zapisAudit } from '../../lib/audit.js';
import { NA_STRANKU, type PodatelnaSluzba } from './sluzba.js';

export default async function podatelnaSprava(app: FastifyInstance, z: { sluzba: PodatelnaSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const pravo = vyzadujRoli('spravce');
  const dnes = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Prague' });

  app.get<{ Querystring: { vse?: string; strana?: string } }>(
    '/sprava/podatelna',
    { preHandler: pravo },
    async (req, reply) => {
      const jenNevyrizene = req.query.vse !== '1';
      const prvni = await sluzba.seznam({ jenNevyrizene, strana: 1 });
      const stran = Math.max(1, Math.ceil(prvni.pocet / NA_STRANKU));
      const strana = Math.min(stran, Math.max(1, Math.floor(Number(req.query.strana)) || 1));
      const { radky, pocet } = strana === 1 ? prvni : await sluzba.seznam({ jenNevyrizene, strana });
      return reply.view('podatelna/sprava/seznam', {
        titulek: t('podatelna.sprava_titulek'),
        radky,
        pocet,
        jenNevyrizene,
        strana,
        stran,
        dnes: dnes(),
        uchovaniLet: app.obec.podatelna.uchovani_let,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/sprava/podatelna/:id', { preHandler: pravo }, async (req, reply) => {
    const p = await sluzba.detail(req.params.id);
    if (!p) return reply.callNotFound();
    return reply.view('podatelna/sprava/detail', {
      titulek: t('podatelna.detail_titulek', { cislo: p.cislo }),
      p,
      dnes: dnes(),
    });
  });

  app.post<{ Params: { id: string }; Body: { akce?: string; poznamka?: string } }>(
    '/sprava/podatelna/:id',
    { preHandler: pravo },
    async (req, reply) => {
      const akce = req.body?.akce;
      // vyrizeno = označit vyřízené, otevrit = vrátit mezi nevyřízená, poznamka = jen uložit poznámku
      if (akce !== 'vyrizeno' && akce !== 'otevrit' && akce !== 'poznamka') return reply.code(400).send();
      const stav = akce === 'vyrizeno' ? true : akce === 'otevrit' ? false : null;
      const r = await sluzba.nastavVyrizeni(
        req.params.id,
        stav,
        String(req.body?.poznamka ?? ''),
        req.uzivatel!.id,
      );
      if (!r) return reply.callNotFound();
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: `podatelna.${akce === 'otevrit' ? 'znovu_otevreno' : akce}`,
        detail: { cislo: r.cislo, id: req.params.id },
        ip: req.ip,
      });
      const text =
        akce === 'vyrizeno'
          ? 'podatelna.ulozeno_vyrizeno'
          : akce === 'otevrit'
            ? 'podatelna.ulozeno_otevreno'
            : 'podatelna.ulozeno_poznamka';
      req.session.flash = { typ: 'ok', text: t(text, { cislo: r.cislo }) };
      return reply.redirect(
        akce === 'vyrizeno' ? '/sprava/podatelna' : `/sprava/podatelna/${req.params.id}`,
        303,
      );
    },
  );
}
