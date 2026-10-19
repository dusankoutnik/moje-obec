// Start serveru: načte .env a obec.yml, sestaví aplikaci, pustí migrace a začne poslouchat.
import { nactiEnv } from './config/env.js';
import { vytvorApp } from './app.js';

const env = nactiEnv();
const app = await vytvorApp({ env });

const zavri = async (signal: string) => {
  app.log.info({ signal }, 'ukončuji');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void zavri('SIGTERM'));
process.on('SIGINT', () => void zavri('SIGINT'));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ url: env.BASE_URL, obec: app.obec.obec.nazev }, 'Moje obec 2.0 běží');
