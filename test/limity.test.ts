// Ochrana přihlašování kódem (nález M. Ketnera ve VlastiKanálu, přeneseno do platformy):
// neutrální odpověď správy odběru, limity podle IP, nepodvrhnutelná IP, blokace až po ověření kódu.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfZ, devKodZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';
import { vytvorLimit } from '../src/lib/limit.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

function zIp(ip: string) {
  const p = new Prohlizec(t.base);
  p.hlavicky = { 'x-forwarded-for': ip };
  return p;
}

async function zadostOKod(p: Prohlizec, telefon: string) {
  const f = await p.get('/infokanal');
  return p.post('/infokanal/kod', { _csrf: csrfZ(f.text), telefon });
}

describe('limit v paměti', () => {
  it('posuvné okno', () => {
    const l = vytvorLimit(2, 1);
    expect(l.zkus('a', 0)).toBe(true);
    expect(l.zkus('a', 1)).toBe(true);
    expect(l.zkus('a', 2)).toBe(false);
    expect(l.zkus('b', 2)).toBe(true);
    expect(l.zkus('a', 60_001)).toBe(true);
  });
});

describe('správa odběru kódem', () => {
  it('neznámé číslo: stejná stránka jako u odběratele, ale žádná SMS', async () => {
    const pred = t.sms.odeslane.length;
    const r = await zadostOKod(zIp('203.0.113.10'), '777999001');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('Pokud číslo');
    expect(r.text).not.toContain('kód z SMS je');
    expect(t.sms.odeslane.length).toBe(pred);
    const o = await t.app.db
      .selectFrom('otp_kody')
      .selectAll()
      .where('kontakt', '=', '+420777999001')
      .execute();
    expect(o).toHaveLength(0);
  });

  it('existující odběratel dostane kód a stránka zní stejně', async () => {
    await t.db
      .insertInto('ik_odberatele')
      .values({ jmeno: 'Známý', telefon: '+420777999002', token: 'test-token-limity' })
      .execute();
    const r = await zadostOKod(zIp('203.0.113.11'), '777999002');
    expect(r.text).toContain('Pokud číslo');
    expect(t.sms.odeslane.at(-1)?.text).toContain('Kod pro spravu odberu');
    expect(devKodZ(r.text)).toMatch(/^\d{6}$/);
  });
});

describe('limity podle IP', () => {
  it('11. žádost o kód z jedné IP dostane 429, jiná IP projde', async () => {
    const p = zIp('203.0.113.20');
    for (let i = 0; i < 10; i++) expect((await zadostOKod(p, `7779990${10 + i}`)).res.status).toBe(200);
    const jedenacta = await zadostOKod(p, '777999099');
    expect(jedenacta.res.status).toBe(429);
    expect(jedenacta.text).toContain('Příliš mnoho pokusů');
    expect((await zadostOKod(zIp('203.0.113.21'), '777999098')).res.status).toBe(200);
  });

  it('podvržená adresa na začátku X-Forwarded-For limit neobejde', async () => {
    const p = zIp('203.0.113.30');
    for (let i = 0; i < 10; i++) await zadostOKod(p, `7779991${10 + i}`);
    p.hlavicky = { 'x-forwarded-for': '198.51.100.7, 203.0.113.30' }; // útočník přidá vlastní, NPM připojí skutečnou
    expect((await zadostOKod(p, '777999199')).res.status).toBe(429);
  });

  it('hádání kódu: 21. ověření z jedné IP dostane 429', async () => {
    const p = zIp('203.0.113.40');
    const f = await p.get('/infokanal');
    let csrf = csrfZ(f.text);
    for (let i = 0; i < 20; i++) {
      const r = await p.post('/infokanal/overeni', { _csrf: csrf, telefon: '777999300', kod: '000000' });
      expect(r.res.status).toBe(200);
      csrf = csrfZ(r.text);
    }
    const r = await p.post('/infokanal/overeni', { _csrf: csrf, telefon: '777999300', kod: '000000' });
    expect(r.res.status).toBe(429);
  });
});

describe('blokovaný účet', () => {
  it('blokaci prozradí až po správném kódu', async () => {
    await prihlasTelefonem(zIp('203.0.113.50'), '777999400');
    await t.db
      .updateTable('uzivatele')
      .set({ blokovan_at: new Date() })
      .where('telefon', '=', '+420777999400')
      .execute();
    const p = zIp('203.0.113.51');
    const inter = await p.get('/prihlaseni');
    const uid = inter.url.split('/oidc/interaction/')[1]!.split('/')[0];
    const kodStranka = await p.post(`/oidc/interaction/${uid}/telefon`, {
      _csrf: csrfZ(inter.text),
      telefon: '777999400',
    });
    expect(kodStranka.text).not.toContain('zablokovaný');
    const po = await p.post(`/oidc/interaction/${uid}/kod`, {
      _csrf: csrfZ(kodStranka.text),
      telefon: '777999400',
      kod: devKodZ(kodStranka.text),
    });
    expect(po.text).toContain('zablokovaný');
  });
});
