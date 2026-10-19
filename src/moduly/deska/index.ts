// Modul „úřední deska“: úřední deska (§ 26 správního řádu), rozpočtová dokumentace (zák. 250/2000 Sb.)
// a povinně zveřejňované informace (vyhláška 515/2020 Sb.).
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { DeskaSluzba } from './sluzba.js';
import deskaRoutes from './routes.js';
import deskaSprava from './sprava.js';

declare module 'fastify' {
  interface FastifyInstance {
    deska: DeskaSluzba;
  }
}

async function deskaModul(app: FastifyInstance) {
  const sluzba = new DeskaSluzba(app.db);
  app.decorate('deska', sluzba);
  await app.register(deskaRoutes, { sluzba });
  await app.register(deskaSprava, { sluzba });
}

export default fp(deskaModul, { name: 'deskaModul' });
