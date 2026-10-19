// Modul „účty“: vestavěný OIDC provider (/oidc/*), přihlašovací interakce, vlastní OIDC klient, profil, správa.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { vytvorProvider, zajistiKlientaPlatformy, OIDC_PREFIX } from './oidc/provider.js';
import { vytvorOidcKlienta } from './oidc/klient.js';
import { uklidOidc } from './oidc/adapter.js';
import { UctySluzba } from './sluzba.js';
import interakceRoutes from './interakce.js';
import uctyRoutes from './routes.js';
import spravaRoutes from './sprava.js';

declare module 'fastify' {
  interface FastifyInstance {
    ucty: UctySluzba;
  }
}

// fastify-plugin: dekorátory (app.ucty, app.infokanal…) mají být vidět v celé aplikaci, ne jen v tomto modulu
async function uctyModul(app: FastifyInstance) {
  const provider = await vytvorProvider(app.db, app.env, app.obec);
  await zajistiKlientaPlatformy(app.db, app.env);
  const klient = vytvorOidcKlienta(app.env);
  const ucty = new UctySluzba(app.db);
  app.decorate('ucty', ucty);

  // Endpointy providera (Koa) pod /oidc/*: tělo požadavku NESMÍ Fastify přečíst — čte si ho provider sám.
  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', (_req, _payload, done) => done(null));
    const handler = provider.callback();
    // originalUrl (jako u Expressu) říká provideru, pod jakou cestou je namountovaný → správné URL v discovery
    const predej = (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      const raw = req.raw as IncomingMessage & { originalUrl?: string };
      raw.originalUrl = raw.url;
      raw.url = raw.url!.slice(OIDC_PREFIX.length) || '/';
      handler(raw, reply.raw);
    };
    sub.all(`${OIDC_PREFIX}/*`, predej);
    sub.all(OIDC_PREFIX, predej);
  });

  await app.register(interakceRoutes, { provider, ucty });
  await app.register(uctyRoutes, { klient, ucty });
  await app.register(spravaRoutes, { ucty });

  // úklid: prošlé OIDC záznamy, sezení a OTP kódy — každou hodinu
  if (app.env.NODE_ENV !== 'test') {
    const job = new Cron('15 * * * *', async () => {
      await uklidOidc(app.db).catch((e) => app.log.warn({ err: e }, 'úklid oidc'));
      await app.sessionStore.uklid().catch((e) => app.log.warn({ err: e }, 'úklid sezení'));
      await app.otp.uklid().catch((e) => app.log.warn({ err: e }, 'úklid otp'));
    });
    app.addHook('onClose', async () => job.stop());
  }
}

export default fp(uctyModul, { name: 'uctyModul' });
