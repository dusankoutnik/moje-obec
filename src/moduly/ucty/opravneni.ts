// Pomocníci pro ochranu rout: přihlášení a role. Nepřihlášený → na přihlášení (s návratem), bez role → 403.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../../db/types.js';
import { maRoli } from './sluzba.js';

export async function vyzadujPrihlaseni(req: FastifyRequest, reply: FastifyReply) {
  if (req.uzivatel) return;
  const zpet = req.url;
  return reply.redirect(`/prihlaseni?zpet=${encodeURIComponent(zpet)}`);
}

export function vyzadujRoli(...role: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.uzivatel) return reply.redirect(`/prihlaseni?zpet=${encodeURIComponent(req.url)}`);
    if (!maRoli(req.uzivatel, ...role)) {
      const chyba = new Error('forbidden') as Error & { statusCode: number };
      chyba.statusCode = 403;
      throw chyba;
    }
  };
}
