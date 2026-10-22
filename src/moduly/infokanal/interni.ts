// Interní API infokanálu pro aplikace obce (náhrada POST /api/send a GET /api/subscriber-pref VlastiKanálu).
//   POST /api/interni/odeslat {prijemci:[{telefon?,email?}], sms?, email?:{predmet,text,html?}, zdroj, bezPrefixu?}
//        → 202 {id, sms, email, zkraceno}; GET /api/interni/odeslat/:id → stav zpráv dávky
//   GET  /api/interni/odber?telefon= → {odebira, kanal:'sms'|'mixed'|'email', email?}
// Ověření: x-api-secret = INTERNI_API_SECRET (src/lib/interni-api.ts).
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../../lib/audit.js';
import { overeniInternihoApi } from '../../lib/interni-api.js';
import { normalizujTelefon } from '../../lib/kontakty.js';
import type { OdchoziFronta, PozadavekOdeslani } from './odchozi.js';

const KANAL_VEN = { sms: 'sms', smisene: 'mixed', email: 'email' } as const;

export default async function interniInfokanal(app: FastifyInstance, z: { odchozi: OdchoziFronta }) {
  const overeni = overeniInternihoApi(app.env.INTERNI_API_SECRET);

  app.post<{ Body: PozadavekOdeslani }>(
    '/api/interni/odeslat',
    { preHandler: overeni, bodyLimit: 512 * 1024 },
    async (req, reply) => {
      const b = (req.body ?? {}) as PozadavekOdeslani;
      const v = await z.odchozi.zarad(b);
      if ('chyba' in v) return reply.code(400).send(v);
      await zapisAudit(app.db, {
        akce: 'infokanal.interni_odeslani',
        detail: {
          davka: v.id,
          zdroj: String(b.zdroj ?? '').slice(0, 40),
          sms: v.sms,
          email: v.email,
          zkraceno: v.zkraceno,
        },
      });
      return reply.code(202).send(v);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/interni/odeslat/:id',
    { preHandler: overeni },
    async (req, reply) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ chyba: 'nenalezeno' });
      const zpravy = await z.odchozi.stavDavky(req.params.id);
      if (!zpravy.length) return reply.code(404).send({ chyba: 'nenalezeno' });
      return { id: req.params.id, zpravy };
    },
  );

  app.get<{ Querystring: { telefon?: string } }>(
    '/api/interni/odber',
    { preHandler: overeni },
    async (req, reply) => {
      const tel = normalizujTelefon(req.query.telefon);
      if (!tel) return reply.code(400).send({ chyba: 'telefon' });
      const o = await app.infokanal.odberatelPodleTelefonu(tel);
      if (!o) return { odebira: false };
      const odebira = !!o.overen_at && !o.odhlasen_at;
      return { odebira, kanal: KANAL_VEN[o.kanal] ?? 'sms', ...(o.email ? { email: o.email } : {}) };
    },
  );
}
