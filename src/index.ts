// Start serveru: načte .env a obec.yml, sestaví aplikaci, pustí migrace a začne poslouchat.
import { nactiEnv } from './config/env.js';
import { vytvorApp } from './app.js';

const env = nactiEnv();
const app = await vytvorApp({ env });

// Ukončení jen jednou (SIGTERM + SIGINT nesmí zavírat dvakrát) a s pojistkou: když se zavírání zasekne
// (dlouhý požadavek, nedostupná DB), proces po 10 s skončí stejně.
let konci = false;
const zavri = async (signal: string) => {
  if (konci) return;
  konci = true;
  app.log.info({ signal }, 'ukončuji');
  setTimeout(() => {
    app.log.error('ukončování trvá příliš dlouho — končím natvrdo');
    process.exit(1);
  }, 10_000).unref();
  try {
    await app.close();
    process.exit(0);
  } catch (e) {
    app.log.error({ err: e }, 'chyba při ukončování');
    process.exit(1);
  }
};
process.on('SIGTERM', () => void zavri('SIGTERM'));
process.on('SIGINT', () => void zavri('SIGINT'));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ url: env.BASE_URL, obec: app.obec.obec.nazev }, 'Moje obec 2.0 běží');
