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
import interniInfokanal from './interni.js';
import { OdchoziFronta } from './odchozi.js';
import { PrichoziSluzba } from './prichozi.js';
import { HlidaniBrany } from './brana.js';
import { SmsGate } from '../../lib/sms/smsgate.js';
import { mapaPresmerovani } from '../../lib/sms/presmerovani.js';

declare module 'fastify' {
  interface FastifyInstance {
    infokanal: InfokanalSluzba;
    infokanalFronta: RozesilaciFronta;
    infokanalOdchozi: OdchoziFronta;
    infokanalPrichozi: PrichoziSluzba;
  }
}

// fastify-plugin: dekorátory (app.ucty, app.infokanal…) mají být vidět v celé aplikaci, ne jen v tomto modulu
async function infokanalModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const sluzba = new InfokanalSluzba(app.db, { smsPrefix: app.obec.texty.sms_prefix });
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

  // odchozí fronta interního API (jednotlivé SMS/e-maily aplikací, odpovědi na příchozí SMS)
  const odchozi = new OdchoziFronta(
    app.db,
    app.sms,
    app.mail,
    {
      smsPrefix: app.obec.texty.sms_prefix,
      smsIntervalMs: app.env.IK_SMS_INTERVAL_MIN_MS,
      emailIntervalMs: app.env.IK_EMAIL_INTERVAL_MS,
    },
    app.log,
  );
  app.decorate('infokanalOdchozi', odchozi);
  const odvozUrl =
    app.env.SPOLUJIZDA_HOOK_URL ||
    (app.env.APLIKACE_REZERVACE_URL
      ? app.env.APLIKACE_REZERVACE_URL.replace(/\/+$/, '') + '/api/sms/prichozi'
      : null);
  const odvozHlavicky: Record<string, string> = {};
  if (app.env.SPOLUJIZDA_HOOK_SECRET) odvozHlavicky['x-hook-secret'] = app.env.SPOLUJIZDA_HOOK_SECRET;
  if (app.env.INTERNI_API_SECRET) odvozHlavicky['x-api-secret'] = app.env.INTERNI_API_SECRET;
  const prichozi = new PrichoziSluzba(
    app.db,
    odchozi,
    app.mail,
    {
      odvozUrl,
      odvozHlavicky,
      notify: seznam(app.env.INFOKANAL_NOTIFY),
      nazevKanalu: app.obec.texty.nazev_infokanalu,
    },
    app.log,
  );
  app.decorate('infokanalPrichozi', prichozi);
  await app.register(interniInfokanal, { odchozi });

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
      let zmeny: { branaId: string; stav: string }[] = [];
      let zpravy: { od: string; text: string; prijato: Date | null }[] = [];
      try {
        if (app.sms.zpracujWebhook) zmeny = await app.sms.zpracujWebhook(req.body, req.headers);
        if (app.sms.prichoziZWebhooku) zpravy = app.sms.prichoziZWebhooku(req.body, req.headers);
      } catch (e) {
        req.log.warn({ err: e }, 'webhook SMS: odmítnuto');
        return reply.code(400).send({ ok: false });
      }
      const n = (await fronta.zapisDorucenky(zmeny)) + (await odchozi.zapisDorucenky(zmeny));
      // příchozí SMS: zpracovat postupně, chyba jedné nesmí shodit ostatní (brána by webhook opakovala)
      for (const z of zpravy) {
        await prichozi.zpracuj(z).catch((e) => req.log.error({ err: e }, 'příchozí SMS: zpracování selhalo'));
      }
      return reply.send({ ok: true, zmen: n, prichozich: zpravy.length });
    });
  });

  // hlídání brány jen u SMSGate (telefon na úřadě); komerční brány mají vlastní dohled
  const branaCfg =
    app.env.SMSGATE_URL &&
    app.env.SMSGATE_USER &&
    (app.env.SMS_PROVIDER === 'smsgate' ||
      (mapaPresmerovani(app.env).size > 0 && app.env.SMS_PRESMEROVANI_PROVIDER === 'smsgate'))
      ? {
          zaklad: new SmsGate({
            url: app.env.SMSGATE_URL,
            user: app.env.SMSGATE_USER,
            pass: app.env.SMSGATE_PASS ?? '',
          }).zakladApi,
          user: app.env.SMSGATE_USER,
          pass: app.env.SMSGATE_PASS ?? '',
          limitMin: app.env.BRANA_LIMIT_MIN,
          notify: seznam(app.env.BRANA_NOTIFY),
        }
      : null;

  if (!volby.planovac) {
    fronta.vypniPlanovac();
    odchozi.vypniPlanovac();
  }
  if (volby.planovac) {
    app.addHook('onReady', async () => {
      fronta.kopni();
      odchozi.kopni();
    });
    const odchoziCron = new Cron('* * * * *', { protect: true }, async () => {
      await odchozi.uklidZaseknute().catch((e) => app.log.warn({ err: e }, 'odchozí: úklid zaseknutých'));
      odchozi.kopni();
    });
    const odchoziDorucenky = new Cron('2-59/5 * * * *', { protect: true }, async () => {
      await odchozi.aktualizujDorucenky().catch((e) => app.log.warn({ err: e }, 'odchozí: doručenky'));
    });
    const hlidac = branaCfg ? new HlidaniBrany(app.db, app.mail, branaCfg, app.log) : null;
    const branaCron = hlidac
      ? new Cron('3-59/10 * * * *', { protect: true }, async () => {
          await hlidac.kontrola().catch((e) => app.log.warn({ err: e }, 'hlídání brány'));
        })
      : null;
    app.addHook('onClose', async () => {
      odchoziCron.stop();
      odchoziDorucenky.stop();
      branaCron?.stop();
      odchozi.zastav();
    });
    const kazdouMinutu = new Cron('* * * * *', { protect: true }, async () => {
      await fronta.uklidZaseknute().catch((e) => app.log.warn({ err: e }, 'fronta: úklid zaseknutých'));
      fronta.kopni();
    });
    // protect: další běh nezačne, dokud předchozí (pomalá brána) neskončí
    const dorucenky = new Cron('*/5 * * * *', { protect: true }, async () => {
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

function seznam(s: string | undefined): string[] {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

export default fp(infokanalModul, { name: 'infokanalModul' });
