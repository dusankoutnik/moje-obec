// Výběr poskytovatele SMS podle SMS_PROVIDER. Nový poskytovatel = nový soubor + řádek tady.
import type { Env } from '../../config/env.js';
import type { Logger } from '../logger.js';
import { KonzoleSms } from './konzole.js';
import { SmsGate } from './smsgate.js';
import { SmsBrana } from './smsbrana.js';
import { GoSms } from './gosms.js';
import { SmsManager } from './smsmanager.js';
import type { SmsPoskytovatel } from './typy.js';
import { mapaPresmerovani, PresmerovaniSms } from './presmerovani.js';

export function vytvorSmsPoskytovatele(env: Env, log: Logger): SmsPoskytovatel {
  const zaklad = poskytovatel(env.SMS_PROVIDER, env, log);
  const mapa = mapaPresmerovani(env);
  if (!mapa.size) return zaklad;
  const skutecny = poskytovatel(env.SMS_PRESMEROVANI_PROVIDER, env, log);
  log.info(
    { cisel: mapa.size, pres: skutecny.nazev },
    'SMS: přesměrování vybraných čísel na skutečnou bránu',
  );
  return new PresmerovaniSms(zaklad, skutecny, mapa);
}

function poskytovatel(nazev: Env['SMS_PROVIDER'], env: Env, log: Logger): SmsPoskytovatel {
  switch (nazev) {
    case 'smsgate':
      return new SmsGate({
        url: env.SMSGATE_URL ?? '',
        user: env.SMSGATE_USER ?? '',
        pass: env.SMSGATE_PASS ?? '',
      });
    case 'smsbrana':
      return new SmsBrana({
        login: env.SMSBRANA_LOGIN ?? '',
        password: env.SMSBRANA_PASSWORD ?? '',
        odesilatel: env.SMS_ODESILATEL,
      });
    case 'gosms':
      return new GoSms({
        clientId: env.GOSMS_CLIENT_ID ?? '',
        clientSecret: env.GOSMS_CLIENT_SECRET ?? '',
        channel: env.GOSMS_CHANNEL ?? '',
      });
    case 'smsmanager':
      return new SmsManager({ apiKey: env.SMSMANAGER_APIKEY ?? '', odesilatel: env.SMS_ODESILATEL });
    default:
      return new KonzoleSms(log);
  }
}

export type { SmsPoskytovatel, StavDoruceni, VysledekOdeslani } from './typy.js';
