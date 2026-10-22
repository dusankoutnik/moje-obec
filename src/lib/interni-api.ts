// Ověření interního API pro aplikace obce (rezervace, eKnihy): hlavička x-api-secret = INTERNI_API_SECRET,
// porovnání v konstantním čase. Bez env je API vypnuté (404). Požadavek s X-Forwarded-For přišel přes reverzní
// proxy zvenku → 404 (aplikace volají platformu napřímo po vnitřní síti).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { stejneTajemstvi } from './krypto.js';

export function overeniInternihoApi(tajemstvi: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!tajemstvi || req.headers['x-forwarded-for']) return reply.code(404).send({ chyba: 'nenalezeno' });
    const h = req.headers['x-api-secret'];
    if (typeof h !== 'string' || !stejneTajemstvi(h, tajemstvi))
      return reply.code(401).send({ chyba: 'neplatny_klic' });
  };
}
