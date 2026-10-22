// Správa → API a integrace (jen admin): založení tokenu (ukáže se jen jednou), zrušení, poslední použití.
import type { FastifyInstance } from 'fastify';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { jeRozsah, POPIS_ROZSAHU, ROZSAHY, type ApiTokenySluzba, type Rozsah } from './tokeny.js';

type Telo = Record<string, string | string[] | undefined>;

export default async function apiSprava(app: FastifyInstance, z: { tokeny: ApiTokenySluzba }) {
  const admin = vyzadujRoli('admin');
  const stranka = async (data: Record<string, unknown> = {}) => ({
    titulek: 'API a integrace',
    tokeny: await z.tokeny.seznam(),
    rozsahy: ROZSAHY,
    popis: POPIS_ROZSAHU,
    base: app.env.BASE_URL,
    ...data,
  });

  app.get('/sprava/api', { preHandler: admin }, async (_req, reply) =>
    reply.view('api/sprava', await stranka()),
  );

  app.post<{ Body: Telo }>('/sprava/api', { preHandler: admin }, async (req, reply) => {
    const b = req.body ?? {};
    const nazev = String(Array.isArray(b.nazev) ? b.nazev[0] : (b.nazev ?? '')).trim();
    const vybrane = (
      b.rozsahy === undefined ? [] : Array.isArray(b.rozsahy) ? b.rozsahy : [b.rozsahy]
    ).filter(jeRozsah);
    if (!nazev || !vybrane.length)
      return reply
        .code(400)
        .view('api/sprava', await stranka({ chyba: 'Vyplňte název a vyberte aspoň jedno oprávnění.', f: b }));
    const { id, token } = await z.tokeny.zaloz(nazev, vybrane as Rozsah[], req.uzivatel!.id, req.ip);
    reply.header('cache-control', 'no-store');
    return reply.view('api/sprava', await stranka({ novy: { id, token, nazev } }));
  });

  app.post<{ Params: { id: string } }>(
    '/sprava/api/:id/zrusit',
    { preHandler: admin },
    async (req, reply) => {
      const ok =
        /^[0-9a-f-]{36}$/i.test(req.params.id) &&
        (await z.tokeny.zrus(req.params.id, req.uzivatel!.id, req.ip));
      req.session.flash = ok
        ? { typ: 'ok', text: 'Token je zrušený — integrace s ním už nefunguje.' }
        : { typ: 'chyba', text: 'Token nenalezen nebo už byl zrušený.' };
      return reply.redirect('/sprava/api');
    },
  );
}
