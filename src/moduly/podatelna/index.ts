// Modul „podatelna“: veřejný formulář elektronické podatelny pro podání bez elektronického podpisu
// (náhrada formulářů typu Contact Form 7 na webech obcí). Podání se uloží do DB s číslem, odejde e-mailem
// na adresu podatelny (Reply-To podatel) a podatel dostane automatické potvrzení doručení.
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { PodatelnaSluzba } from './sluzba.js';
import podatelnaRoutes from './routes.js';
import podatelnaSprava from './sprava.js';

declare module 'fastify' {
  interface FastifyInstance {
    podatelna: PodatelnaSluzba;
  }
}

async function podatelnaModul(app: FastifyInstance) {
  const sluzba = new PodatelnaSluzba(app.db, app.obec, app.mail, app.log);
  app.decorate('podatelna', sluzba);
  await app.register(podatelnaRoutes, { sluzba });
  await app.register(podatelnaSprava, { sluzba });
}

export default fp(podatelnaModul, { name: 'podatelnaModul' });
