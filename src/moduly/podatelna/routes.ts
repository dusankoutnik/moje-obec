// Veřejný formulář elektronické podatelny (podání bez elektronického podpisu a přílohy).
// Obyčejný formulář: funguje bez JavaScriptu (POST → přesměrování → GET). Ochrana: CSRF (globálně v app.ts),
// limit podle IP (app.limity.podani) a past na roboty (skryté pole „web“ — vyplněné = tváříme se, že je hotovo).
import type { FastifyInstance } from 'fastify';
import { hlidejLimit } from '../../lib/limit.js';
import { zapisAudit } from '../../lib/audit.js';
import { DELKY, overFormular, type FormularPodani, type PodatelnaSluzba } from './sluzba.js';

declare module 'fastify' {
  interface Session {
    /** číslo právě přijatého podání pro stránku s poděkováním */
    podatelnaPrijato?: { cislo: string | null; email: boolean } | null;
  }
}

export default async function podatelnaRoutes(app: FastifyInstance, z: { sluzba: PodatelnaSluzba }) {
  const { sluzba } = z;
  const t = app.t;

  const vykresli = (f: FormularPodani, chyby: Record<string, string> = {}) => ({
    titulek: t('podatelna.titulek'),
    f,
    chyby,
    delky: DELKY,
  });

  app.get('/podatelna', async (_req, reply) => reply.view('podatelna/formular', vykresli({})));

  app.post<{ Body: FormularPodani }>(
    '/podatelna',
    { preHandler: hlidejLimit(app.limity.podani) },
    async (req, reply) => {
      const f = req.body ?? {};
      if (String(f.web ?? '').trim()) {
        // robot: nic neukládat ani neposílat, odpověď stejná jako u člověka (bez čísla podání)
        req.log.info('podatelna: vyplněná past na roboty, podání zahozeno');
        req.session.podatelnaPrijato = { cislo: null, email: false };
        return reply.redirect('/podatelna/prijato', 303);
      }
      const v = overFormular(f);
      if (!v.ok) return reply.code(400).view('podatelna/formular', vykresli(f, v.chyby));
      const p = await sluzba.zaloz(v.udaje);
      await zapisAudit(app.db, {
        akce: 'podatelna.prijato',
        detail: { cislo: p.cislo, id: p.id },
        ip: req.ip,
      });
      await sluzba.odesli(p, app.env.BASE_URL);
      req.session.podatelnaPrijato = { cislo: p.cislo, email: !!p.email };
      return reply.redirect('/podatelna/prijato', 303);
    },
  );

  app.get('/podatelna/prijato', async (req, reply) => {
    const prijato = req.session?.podatelnaPrijato;
    if (!prijato) return reply.redirect('/podatelna');
    req.session.podatelnaPrijato = null;
    return reply.view('podatelna/prijato', { titulek: t('podatelna.prijato_titulek'), prijato });
  });
}
