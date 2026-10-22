// Interní API účtů pro aplikace obce (rezervace, eKnihy) — volá se jen po vnitřní síti, ne přes reverzní proxy.
// Hlavička x-api-secret = INTERNI_API_SECRET (porovnání v konstantním čase); bez env je API vypnuté (404).
// Požadavek s X-Forwarded-For přišel přes proxy zvenku → 404 (aplikace volají platformu napřímo).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROLE, type Role } from '../../db/types.js';
import { stejneTajemstvi } from '../../lib/krypto.js';
import { profilUzivatele, type UctySluzba } from './sluzba.js';

export default async function interniRoutes(app: FastifyInstance, z: { ucty: UctySluzba }) {
  const { ucty } = z;
  const tajemstvi = app.env.INTERNI_API_SECRET;

  const overeni = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers['x-api-secret'];
    if (!tajemstvi || req.headers['x-forwarded-for']) return reply.code(404).send({ chyba: 'nenalezeno' });
    if (typeof h !== 'string' || !stejneTajemstvi(h, tajemstvi))
      return reply.code(401).send({ chyba: 'neplatny_klic' });
  };
  const cisloZ = (v: string) => (/^\d{1,9}$/.test(v) ? Number(v) : null);

  app.get<{ Params: { cislo: string } }>(
    '/api/interni/uzivatel/:cislo',
    { preHandler: overeni },
    async (req, reply) => {
      const c = cisloZ(req.params.cislo);
      const u = c === null ? undefined : await ucty.podleCisla(c);
      if (!u) return reply.code(404).send({ chyba: 'nenalezeno' });
      return profilUzivatele(u);
    },
  );

  app.get<{ Querystring: { role?: string } }>(
    '/api/interni/uzivatele',
    { preHandler: overeni },
    async (req, reply) => {
      const role = String(req.query.role ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter((r): r is Role => (ROLE as readonly string[]).includes(r));
      if (!role.length) return reply.code(400).send({ chyba: 'role', povolene: ROLE });
      return { uzivatele: (await ucty.podleRole(role)).map(profilUzivatele) };
    },
  );

  app.post<{ Params: { cislo: string }; Body: { rezident?: unknown; kdo?: unknown } }>(
    '/api/interni/uzivatel/:cislo/rezident',
    { preHandler: overeni },
    async (req, reply) => {
      const c = cisloZ(req.params.cislo);
      const u = c === null ? undefined : await ucty.podleCisla(c);
      if (!u) return reply.code(404).send({ chyba: 'nenalezeno' });
      const b = req.body ?? {};
      if (typeof b.rezident !== 'boolean') return reply.code(400).send({ chyba: 'rezident' });
      // kdo = číslo účtu správce, který v aplikaci klikl (musí být admin nebo správce obce)
      const kdoC = cisloZ(String(b.kdo ?? ''));
      const aktor = kdoC === null ? undefined : await ucty.podleCisla(kdoC);
      if (!aktor || aktor.blokovan_at || !aktor.role.some((r) => r === 'admin' || r === 'spravce'))
        return reply.code(403).send({ chyba: 'kdo' });
      const novy = await ucty.nastavRezident(u, b.rezident, aktor, 'interni-api', req.ip);
      return { ok: true, ...profilUzivatele(novy) };
    },
  );
}
