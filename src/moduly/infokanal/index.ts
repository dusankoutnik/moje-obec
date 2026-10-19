// Modul „infokanál“: odběratelé, hlášení, rozesílací fronta, doručenky (webhook + polling), veřejné stránky.
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import type { Env } from '../../config/env.js';
import { hmac, stejneTajemstvi } from '../../lib/krypto.js';
import { InfokanalSluzba } from './sluzba.js';
import { RozesilaciFronta } from './fronta.js';
import infokanalRoutes from './routes.js';
import infokanalSprava from './sprava.js';

declare module 'fastify' {
  interface FastifyInstance {
    infokanal: InfokanalSluzba;
    infokanalFronta: RozesilaciFronta;
  }
}

// fastify-plugin: dekorátory (app.ucty, app.infokanal…) mají být vidět v celé aplikaci, ne jen v tomto modulu
async function infokanalModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const sluzba = new InfokanalSluzba(app.db);
  const fronta = new RozesilaciFronta(
    app.db,
    app.sms,
    app.mail,
    {
      smsIntervalMinMs: app.env.IK_SMS_INTERVAL_MIN_MS,
      smsIntervalMaxMs: app.env.IK_SMS_INTERVAL_MAX_MS,
      emailIntervalMs: app.env.IK_EMAIL_INTERVAL_MS,
      baseUrl: app.env.BASE_URL,
      smsPrefix: app.obec.texty.sms_prefix,
      nazevKanalu: app.obec.texty.nazev_infokanalu,
      nazevObce: app.obec.obec.nazev,
    },
    app.log,
  );
  app.decorate('infokanal', sluzba);
  app.decorate('infokanalFronta', fronta);

  await app.register(infokanalRoutes, { sluzba });
  await app.register(infokanalSprava, { sluzba, fronta });

  // Doručenky z brány (webhook). Ne každá brána podepisuje, proto je v URL tajemství (tajemstviWebhooku). Brána,
  // která podepisuje (SMS Manager), potřebuje k ověření podpisu SUROVÉ tělo — JSON se tu proto čte jako text.
  const tajemstvi = tajemstviWebhooku(app.env);
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, telo, hotovo) => {
      hotovo(null, telo);
    });
    sub.post<{ Params: { tajemstvi: string } }>('/webhook/sms/:tajemstvi', async (req, reply) => {
      if (!stejneTajemstvi(req.params.tajemstvi, tajemstvi)) return reply.code(404).send();
      if (!app.sms.zpracujWebhook) return reply.send({ ok: true, zmen: 0 });
      let zmeny;
      try {
        zmeny = await app.sms.zpracujWebhook(req.body, req.headers);
      } catch (e) {
        req.log.warn({ err: e }, 'webhook SMS: odmítnuto');
        return reply.code(400).send({ ok: false });
      }
      const n = await fronta.zapisDorucenky(zmeny);
      return reply.send({ ok: true, zmen: n });
    });
  });

  if (!volby.planovac) fronta.vypniPlanovac();
  if (volby.planovac) {
    app.addHook('onReady', async () => fronta.kopni());
    const kazdouMinutu = new Cron('* * * * *', () => fronta.kopni());
    const dorucenky = new Cron('*/5 * * * *', async () => {
      await fronta.aktualizujDorucenky().catch((e) => app.log.warn({ err: e }, 'doručenky'));
    });
    app.addHook('onClose', async () => {
      kazdouMinutu.stop();
      dorucenky.stop();
      fronta.zastav();
    });
  }
}

/**
 * Tajná část adresy webhooku doručenek: SMS_WEBHOOK_TOKEN, jinak odvozená ze SESSION_SECRET přes HMAC (adresa tak
 * neprozrazuje nic ze samotného klíče sezení). Adresa webhooku je `<BASE_URL>/webhook/sms/<tajemství>`.
 */
export function tajemstviWebhooku(env: Pick<Env, 'SESSION_SECRET' | 'SMS_WEBHOOK_TOKEN'>): string {
  return env.SMS_WEBHOOK_TOKEN || hmac(env.SESSION_SECRET, 'webhook-sms').slice(0, 40);
}

export default fp(infokanalModul, { name: 'infokanalModul' });
