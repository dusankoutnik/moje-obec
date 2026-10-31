// Modul „api“: REST API /api/v1 pro integrace (příspěvky, deska, soubory, rozesílka, zpravodaj), tokeny ve správě,
// Swagger UI /api, textová dokumentace /api/dokumentace a /api/openapi.json (strojová). Viz docs/MODULY.md → API.
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ApiTokenySluzba, POPIS_ROZSAHU, ROZSAHY } from './tokeny.js';
import { vytvorOvereni, LIMIT_TOKENU } from './spolecne.js';
import apiV1 from './v1.js';
import apiSprava from './sprava.js';
import { openapi } from './openapi.js';

declare module 'fastify' {
  interface FastifyInstance {
    apiTokeny: ApiTokenySluzba;
  }
}

async function apiModul(app: FastifyInstance) {
  const tokeny = new ApiTokenySluzba(app.db);
  app.decorate('apiTokeny', tokeny);
  const overeni = vytvorOvereni(app, tokeny);
  await app.register(apiV1, { prefix: '/api/v1', tokeny, overeni });
  await app.register(apiSprava, { tokeny });

  app.get('/api/openapi.json', async (_req, reply) =>
    reply.header('access-control-allow-origin', '*').send(openapi(app.env.BASE_URL, app.obec.obec.nazev)),
  );
  // /api = Swagger UI nad /api/openapi.json (vlastní stránka bez rámce webu; skript v public/js/api-swagger.js kvůli CSP)
  app.get('/api', async (_req, reply) =>
    reply.view('api/swagger', {
      titulek: 'API webu obce',
      base: app.env.BASE_URL,
      nazevObce: app.obec.obec.nazev,
    }),
  );
  app.get('/api/dokumentace', async (_req, reply) =>
    reply.view('api/dokumentace', {
      titulek: 'API webu obce',
      base: app.env.BASE_URL,
      rozsahy: ROZSAHY,
      popis: POPIS_ROZSAHU,
      limit: LIMIT_TOKENU,
    }),
  );
}

export default fp(apiModul, { name: 'apiModul' });
