// Registrace webhooků SMSGate na platformu (příchozí SMS + doručenky) — jednorázově při nasazení / přechodu.
//
//   node dist/scripts/smsgate-webhook.js            vypíše registrované webhooky (adresy bez tajné části)
//   node dist/scripts/smsgate-webhook.js --zapsat   zaregistruje sms:received, sms:delivered, sms:failed
//                                                   na <BASE_URL>/webhook/sms/<tajemství>
// Starý webhook VlastiKanálu (…/api/sms-webhook/…) je potřeba po přechodu smazat: --smazat <id>.
import { nactiEnv } from '../config/env.js';
import { tajemstviWebhooku } from '../moduly/infokanal/index.js';
import { SmsGate } from '../lib/sms/smsgate.js';

const env = nactiEnv();
if (!env.SMSGATE_URL || !env.SMSGATE_USER) {
  console.error('Chybí SMSGATE_URL / SMSGATE_USER.');
  process.exit(2);
}
const zaklad = new SmsGate({ url: env.SMSGATE_URL, user: env.SMSGATE_USER, pass: env.SMSGATE_PASS ?? '' })
  .zakladApi;
const auth = 'Basic ' + Buffer.from(`${env.SMSGATE_USER}:${env.SMSGATE_PASS ?? ''}`).toString('base64');
const volej = async (cesta: string, init: RequestInit = {}) => {
  const r = await fetch(zaklad + cesta, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: auth },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SMSGate ${r.status}: ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as unknown) : null;
};
const skryj = (u: string) => u.replace(/\/(webhook\/sms|api\/sms-webhook)\/[^/]+$/, '/$1/…');
const argv = process.argv.slice(2);

if (argv[0] === '--smazat' && argv[1]) {
  await volej(`/webhooks/${encodeURIComponent(argv[1])}`, { method: 'DELETE' });
  console.log('Smazáno:', argv[1]);
} else if (argv[0] === '--zapsat') {
  const url = `${env.BASE_URL.replace(/\/+$/, '')}/webhook/sms/${tajemstviWebhooku(env)}`;
  for (const event of ['sms:received', 'sms:delivered', 'sms:failed']) {
    await volej('/webhooks', { method: 'POST', body: JSON.stringify({ url, event }) });
    console.log('Zaregistrováno:', event, skryj(url));
  }
} else {
  const seznam = (await volej('/webhooks')) as { id: string; event: string; url: string }[];
  for (const w of seznam ?? []) console.log(w.id, w.event, skryj(w.url));
}
