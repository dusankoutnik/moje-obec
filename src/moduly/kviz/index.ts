// Modul „kvíz“: kvíz pro občany (obdoba hospodských kvízů) — otázky z YAML balíků, skóre u účtu nebo v cookie.
// Při startu se balíky naimportují do DB (idempotentně); chyba v balíku start nezastaví, jen se zapíše do logu.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Env } from '../../config/env.js';
import { importujBaliky, type VysledekImportu } from './import.js';
import { KvizSluzba } from './sluzba.js';
import kvizRoutes from './routes.js';
import kvizSprava from './sprava.js';

declare module 'fastify' {
  interface FastifyInstance {
    kviz: KvizSluzba;
    /** znovu načte balíky otázek (start, tlačítko ve správě) */
    kvizImport: () => Promise<VysledekImportu>;
  }
}

/** adresáře s balíky: veřejné z repozitáře + balíky obce (KVIZ_BALIKY) */
export function adresareBaliku(env: Pick<Env, 'KVIZ_VEREJNE' | 'KVIZ_BALIKY'>) {
  const verejne = env.KVIZ_VEREJNE ?? path.resolve(import.meta.dirname, '..', '..', '..', 'kviz-otazky');
  return [
    { cesta: verejne, stitek: 'verejne' },
    ...env.KVIZ_BALIKY.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((cesta, i) => ({ cesta, stitek: i ? `obec${i + 1}` : 'obec' })),
  ];
}

async function kvizModul(app: FastifyInstance) {
  const sluzba = new KvizSluzba(app.db);
  app.decorate('kviz', sluzba);
  app.decorate('kvizImport', async () => {
    const v = await importujBaliky(app.db, adresareBaliku(app.env));
    for (const c of v.chyby)
      app.log.error({ soubor: c.soubor, chyba: c.zprava }, 'kvíz: chybný balík otázek');
    app.log.info(
      {
        soubory: v.soubory,
        otazky: v.otazky,
        nove: v.nove,
        zmenene: v.zmenene,
        deaktivovane: v.deaktivovane,
      },
      'kvíz: balíky otázek načteny',
    );
    // výsledek posledního importu pro správu (počty a chyby balíků)
    const hodnota = JSON.stringify({ at: new Date().toISOString(), ...v });
    await app.db
      .insertInto('nastaveni')
      .values({ klic: 'kviz_import', hodnota })
      .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
      .execute();
    return v;
  });
  await app.kvizImport().catch((e) => app.log.error({ err: e }, 'kvíz: import balíků selhal'));
  await app.register(kvizRoutes, { sluzba });
  await app.register(kvizSprava, { sluzba });
}

export default fp(kvizModul, { name: 'kvizModul' });
