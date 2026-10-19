import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { SmsBrana, smsbranaCas } from '../src/lib/sms/smsbrana.js';
import { GoSms, gosmsStav } from '../src/lib/sms/gosms.js';
import { SmsManager } from '../src/lib/sms/smsmanager.js';
import { SmsGate } from '../src/lib/sms/smsgate.js';
import { SmsChyba } from '../src/lib/sms/typy.js';

function falesnyFetch(odpovedi: { status: number; telo: string; typ?: string }[]) {
  const volani: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    volani.push({ url: String(url), init });
    const o = odpovedi.shift() ?? { status: 500, telo: 'nic' };
    return new Response(o.telo, { status: o.status, headers: { 'content-type': o.typ ?? 'text/plain' } });
  }) as unknown as typeof fetch;
  return { f, volani };
}

describe('SMSbrána.cz', () => {
  it('posílá podepsaný požadavek a čte XML odpověď', async () => {
    const { f, volani } = falesnyFetch([
      {
        status: 200,
        telo: `<?xml version='1.0'?><result><err>0</err><price>1.1</price><sms_count>1</sms_count><credit>99</credit><sms_id>377351</sms_id></result>`,
      },
    ]);
    const ted = new Date('2026-10-13T10:15:20+02:00');
    const b = new SmsBrana({ login: 'obec', password: 'tajne', fetch: f, ted: () => ted });
    const v = await b.posli('+420777123456', 'Ahoj');
    expect(v).toEqual({ branaId: '377351', cena: 1.1, segmentu: 1 });
    const q = new URL(volani[0]!.url).searchParams;
    expect(q.get('action')).toBe('send_sms');
    expect(q.get('number')).toBe('+420777123456');
    expect(q.get('time')).toBe('20261013T101520');
    expect(q.get('auth')).toBe(
      createHash('md5')
        .update(`tajne${q.get('time')}${q.get('salt')}`)
        .digest('hex'),
    );
    expect(q.get('hash')).toBe(q.get('auth'));
  });
  it('err≠0 je chyba (HTTP 200)', async () => {
    const { f } = falesnyFetch([{ status: 200, telo: `<result><err>9</err></result>` }]);
    const b = new SmsBrana({ login: 'obec', password: 'tajne', fetch: f });
    await expect(b.posli('+420777123456', 'x')).rejects.toThrow(/kredit/);
  });
  it('parsuje doručenky z inboxu', () => {
    const xml = `<result><inbox><delivery_report><item><idsms>1</idsms><status>1</status></item><item><id_sms>2</id_sms><status>3</status></item></delivery_report></inbox></result>`;
    expect(SmsBrana.parsujDorucenky(xml)).toEqual([
      { branaId: '1', stav: 'doruceno' },
      { branaId: '2', stav: 'selhalo' },
    ]);
  });
  it('čas v pražském pásmu', () => {
    expect(smsbranaCas(new Date('2026-01-05T23:30:00Z'))).toBe('20260106T003000');
  });
});

describe('GoSMS', () => {
  it('získá token a odešle zprávu', async () => {
    const { f, volani } = falesnyFetch([
      {
        status: 200,
        telo: JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
        typ: 'application/json',
      },
      {
        status: 201,
        telo: JSON.stringify({ recipients: { invalid: [] }, link: 'api/v1/messages/42' }),
        typ: 'application/json',
      },
    ]);
    const g = new GoSms({ clientId: 'id', clientSecret: 'sec', channel: '7', fetch: f });
    expect(await g.posli('+420777123456', 'Ahoj')).toEqual({ branaId: '42' });
    expect(volani[0]!.url).toContain('/oauth/v2/token');
    expect((volani[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(volani[1]!.init!.body))).toEqual({
      message: 'Ahoj',
      channel: 7,
      recipients: ['+420777123456'],
    });
  });
  it('neplatné číslo je chyba', async () => {
    const { f } = falesnyFetch([
      { status: 200, telo: JSON.stringify({ access_token: 'tok' }), typ: 'application/json' },
      {
        status: 201,
        telo: JSON.stringify({ recipients: { invalid: ['+420777123456'] }, link: 'api/v1/messages/1' }),
        typ: 'application/json',
      },
    ]);
    const g = new GoSms({ clientId: 'id', clientSecret: 'sec', channel: '7', fetch: f });
    await expect(g.posli('+420777123456', 'x')).rejects.toThrow(SmsChyba);
  });
  it('stav z objektu delivery a webhook', async () => {
    expect(gosmsStav({ recipients: { delivered: { '+420777': '2026' } } })).toBe('doruceno');
    expect(gosmsStav({ recipients: { undelivered: { '+420777': '2026' } } })).toBe('selhalo');
    const g = new GoSms({ clientId: 'id', clientSecret: 'sec', channel: '7', fetch: falesnyFetch([]).f });
    const z = await g.zpracujWebhook(
      [
        {
          event: 'delivery',
          delivery: { recipients: { delivered: { x: 'y' } } },
          links: { message: '/api/v1/messages/9' },
        },
      ],
      {},
    );
    expect(z).toEqual([{ branaId: '9', stav: 'doruceno' }]);
  });
});

describe('SMS Manager', () => {
  it('odešle přes JSON API v2', async () => {
    const { f, volani } = falesnyFetch([
      {
        status: 200,
        telo: JSON.stringify({ request_id: 'r', accepted: [{ key: '0', message_id: 'm-1' }], rejected: [] }),
        typ: 'application/json',
      },
    ]);
    const s = new SmsManager({ apiKey: 'klic', odesilatel: 'Obec', fetch: f });
    expect(await s.posli('+420777123456', 'Ahoj')).toEqual({ branaId: 'm-1' });
    const telo = JSON.parse(String(volani[0]!.init!.body));
    expect(telo.to).toEqual([{ phone_number: '420777123456' }]);
    expect(telo.sender).toBe('Obec');
    expect((volani[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('klic');
  });
  it('odmítnutá zpráva (200 + rejected) je chyba', async () => {
    const { f } = falesnyFetch([
      {
        status: 200,
        telo: JSON.stringify({ accepted: [], rejected: [{ key: '0' }] }),
        typ: 'application/json',
      },
    ]);
    await expect(new SmsManager({ apiKey: 'k', fetch: f }).posli('+420777123456', 'x')).rejects.toThrow(
      /odmítnuta/,
    );
  });
  it('webhook ověří HMAC podpis', async () => {
    const s = new SmsManager({ apiKey: 'k', webhookSecret: 'tajemstvi', fetch: falesnyFetch([]).f });
    const telo = JSON.stringify([{ message_id: 'm-1', result: 'delivered' }]);
    const podpis = createHmac('sha256', 'tajemstvi').update(telo).digest('hex');
    expect(await s.zpracujWebhook(telo, { 'x-request-signature': podpis })).toEqual([
      { branaId: 'm-1', stav: 'doruceno' },
    ]);
    await expect(s.zpracujWebhook(telo, { 'x-request-signature': 'spatny' })).rejects.toThrow(/podpis/);
  });
});

describe('SMSGate', () => {
  it('posílá Basic auth a čte id', async () => {
    const { f, volani } = falesnyFetch([
      { status: 202, telo: JSON.stringify({ id: 'g1', state: 'Pending' }), typ: 'application/json' },
      { status: 200, telo: JSON.stringify({ state: 'Delivered' }), typ: 'application/json' },
    ]);
    const g = new SmsGate({
      url: 'https://api.sms-gate.app/3rdparty/v1/message',
      user: 'U',
      pass: 'P',
      fetch: f,
    });
    expect(await g.posli('+420777123456', 'x')).toEqual({ branaId: 'g1' });
    expect((volani[0]!.init!.headers as Record<string, string>).authorization).toBe(
      'Basic ' + Buffer.from('U:P').toString('base64'),
    );
    expect(await g.stavDoruceni('g1')).toBe('doruceno');
    expect(volani[1]!.url).toBe('https://api.sms-gate.app/3rdparty/v1/message/g1');
  });
});
