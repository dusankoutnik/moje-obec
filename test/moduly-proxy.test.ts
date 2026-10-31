// Moduly obce (Správa → Moduly obce, /api/moduly, skrytí vypnutých) a proxy aplikací /rezervace, /eknihy.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  csrfZ,
  prihlasSRoli,
  Prohlizec,
  spustTestApp,
  testovaciObec,
  volnyPort,
  type TestApp,
} from './pomocnici.js';

interface Zachyceny {
  metoda: string;
  url: string;
  hlavicky: http.IncomingHttpHeaders;
  telo: Buffer;
}

let t: TestApp;
let falesna: http.Server;
let falesnaUrl: string;
const zachycene: Zachyceny[] = [];
let admin: Prohlizec;

function posledni(): Zachyceny {
  return zachycene.at(-1)!;
}

beforeAll(async () => {
  // falešná aplikace rezervací
  falesna = http.createServer((req, res) => {
    const kusy: Buffer[] = [];
    req.on('data', (k: Buffer) => kusy.push(k));
    req.on('end', () => {
      zachycene.push({
        metoda: req.method!,
        url: req.url!,
        hlavicky: req.headers,
        telo: Buffer.concat(kusy),
      });
      const u = req.url!;
      if (u.startsWith('/rezervace/presmeruj')) {
        res.writeHead(302, { location: '/rezervace/cil?x=1' });
        return res.end();
      }
      if (u.startsWith('/rezervace/absolutni')) {
        res.writeHead(303, { location: `${falesnaUrl}/rezervace/po-prihlaseni` });
        return res.end();
      }
      if (u.startsWith('/rezervace/pomalu')) return; // nikdy neodpoví (timeout)
      res.setHeader('set-cookie', ['rez_sezeni=abc; Path=/rezervace; HttpOnly', 'druha=2; Path=/rezervace']);
      res.setHeader('content-security-policy', "default-src 'none'");
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`APLIKACE ${req.method} ${u}`);
    });
  });
  const port = await volnyPort();
  await new Promise<void>((r) => falesna.listen(port, '127.0.0.1', () => r()));
  falesnaUrl = `http://127.0.0.1:${port}`;
  const mrtvy = await volnyPort(); // nikdo neposlouchá → 502
  t = await spustTestApp({
    env: {
      APLIKACE_REZERVACE_URL: falesnaUrl,
      APLIKACE_EKNIHY_URL: `http://127.0.0.1:${mrtvy}`,
      APLIKACE_TIMEOUT_MS: '1500',
      CHAT_URL: falesnaUrl,
      CHAT_TELEFONY: '777 100 001, 777100777',
    },
    obec: { ...testovaciObec, moduly: { ...testovaciObec.moduly, rezervace: true, eknihy: true } },
  });
  admin = await prihlasSRoli(t, '777100001', ['admin']);
});

afterAll(async () => {
  await t.zavri();
  await new Promise((r) => falesna.close(r));
});

async function nastav(stav: Record<string, boolean>) {
  const { text } = await admin.get('/sprava/moduly');
  const data: Record<string, string> = { _csrf: csrfZ(text) };
  for (const [k, v] of Object.entries(stav)) data[k] = v ? '1' : '0';
  const r = await admin.post('/sprava/moduly', data);
  expect(r.res.status).toBe(200);
  return r;
}

const VSE = {
  rezervace: true,
  predprodej: true,
  spolujizda: true,
  eknihy: true,
  infokanal: true,
  kviz: true,
};

describe('proxy aplikací', () => {
  it('/rezervace → 301 /rezervace/ (i s dotazem)', async () => {
    const r = await fetch(t.base + '/rezervace?a=1', { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/rezervace/?a=1');
  });

  it('GET: odpověď 1:1, Set-Cookie aplikace, bez sezení a CSP platformy, hlavičky X-Forwarded-*', async () => {
    const r = await fetch(t.base + '/rezervace/kalendar?d=2026-10-22', {
      headers: { 'x-forwarded-for': '6.6.6.6', 'x-forwarded-prefix': '/jinam', cookie: 'mo_sezeni=x' },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('APLIKACE GET /rezervace/kalendar?d=2026-10-22');
    const cookies = r.headers.getSetCookie();
    expect(cookies).toEqual(['rez_sezeni=abc; Path=/rezervace; HttpOnly', 'druha=2; Path=/rezervace']);
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(r.headers.get('x-frame-options')).toBeNull();
    const z = posledni();
    expect(z.hlavicky.host).toBe(new URL(t.base).host);
    expect(z.hlavicky['x-forwarded-prefix']).toBe('/rezervace');
    expect(z.hlavicky['x-forwarded-proto']).toBe('http');
    expect(z.hlavicky['x-forwarded-host']).toBe(new URL(t.base).host);
    // podvržená hlavička klienta se nepředá — jen IP podle TRUST_PROXY_HOPS (test: 1 skok → poslední z XFF)
    expect(z.hlavicky['x-forwarded-for']).toBe('6.6.6.6');
    expect(z.hlavicky.cookie).toBe('mo_sezeni=x');
  });

  it('POST formulář bez CSRF platformy, tělo beze změny (urlencoded i multipart)', async () => {
    const r = await fetch(t.base + '/rezervace/rezervovat', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'jmeno=Jan%20Nov%C3%A1k&pocet=2&_csrf=aplikace',
    });
    expect(r.status).toBe(200);
    expect(posledni().metoda).toBe('POST');
    expect(posledni().telo.toString()).toBe('jmeno=Jan%20Nov%C3%A1k&pocet=2&_csrf=aplikace');
    expect(posledni().hlavicky['content-type']).toBe('application/x-www-form-urlencoded');

    const fd = new FormData();
    fd.append('popis', 'příloha');
    fd.append(
      'soubor',
      new Blob([Buffer.from([0, 1, 2, 255])], { type: 'application/octet-stream' }),
      'a.bin',
    );
    const r2 = await fetch(t.base + '/rezervace/nahraj', { method: 'POST', body: fd });
    expect(r2.status).toBe(200);
    const z = posledni();
    expect(String(z.hlavicky['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(z.telo.includes(Buffer.from([0, 1, 2, 255]))).toBe(true);
    expect(z.telo.toString('latin1')).toContain('filename="a.bin"');
  });

  it('přesměrování: Location pod prefixem zůstává, absolutní vnitřní adresa se přepíše', async () => {
    const r = await fetch(t.base + '/rezervace/presmeruj', { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/rezervace/cil?x=1');
    const r2 = await fetch(t.base + '/rezervace/absolutni', {
      method: 'POST',
      redirect: 'manual',
      body: 'a=1',
    });
    expect(r2.status).toBe(303);
    expect(r2.headers.get('location')).toBe('/rezervace/po-prihlaseni');
  });

  it('nedostupná aplikace → 502 „Služba je dočasně nedostupná“', async () => {
    const r = await fetch(t.base + '/eknihy/', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('Služba je dočasně nedostupná');
  });

  it('timeout aplikace → 502', async () => {
    const r = await fetch(t.base + '/rezervace/pomalu');
    expect(r.status).toBe(502);
  });
});

describe('moduly obce', () => {
  it('/api/moduly: zapnuté moduly s názvy a adresami', async () => {
    await nastav(VSE);
    const r = await fetch(t.base + '/api/moduly');
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      moduly: { klic: string; nazev: string; url: string; zapnuto: boolean }[];
      zapnuto: Record<string, boolean>;
    };
    expect(j.zapnuto).toEqual(VSE);
    expect(j.moduly.map((m) => m.klic)).toEqual([
      'rezervace',
      'predprodej',
      'spolujizda',
      'infokanal',
      'eknihy',
      'kviz',
    ]);
    expect(j.moduly.find((m) => m.klic === 'infokanal')).toMatchObject({
      nazev: 'TestKanál',
      url: '/infokanal',
    });
    expect(j.moduly.find((m) => m.klic === 'rezervace')).toMatchObject({
      klic: 'rezervace',
      nazev: 'Rezervace',
      url: '/rezervace/',
      zapnuto: true,
    });
  });

  it('vypnutý předprodej a spolujízda: proxy je blokuje, zbytek rezervací jede; audit', async () => {
    await nastav({ ...VSE, predprodej: false, spolujizda: false });
    const pocet = zachycene.length;
    const r = await fetch(t.base + '/rezervace/predprodej/koncert', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('Tato služba není v obci zapnutá');
    expect((await fetch(t.base + '/rezervace/spolujizda')).status).toBe(404);
    expect(zachycene.length).toBe(pocet); // k aplikaci nic nedošlo
    expect((await fetch(t.base + '/rezervace/predprodejni')).status).toBe(200); // jiná cesta
    expect((await fetch(t.base + '/rezervace/')).status).toBe(200);
    const j = (await (await fetch(t.base + '/api/moduly')).json()) as {
      moduly: { klic: string; zapnuto: boolean }[];
      zapnuto: Record<string, boolean>;
    };
    expect(j.zapnuto.predprodej).toBe(false);
    expect(j.moduly.find((m) => m.klic === 'predprodej')!.zapnuto).toBe(false);
    expect(j.moduly).toHaveLength(6);
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('akce', '=', 'moduly.zmena')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ zmeny: { predprodej: false, spolujizda: false } });
  });

  it('vypnuté rezervace: celé /rezervace → 404 platformy, podčásti v API také vypnuté', async () => {
    await nastav({ ...VSE, rezervace: false });
    const r = await fetch(t.base + '/rezervace/', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('Tato služba není v obci zapnutá');
    expect((await fetch(t.base + '/rezervace', { redirect: 'manual' })).status).toBe(404);
    const j = (await (await fetch(t.base + '/api/moduly')).json()) as { zapnuto: Record<string, boolean> };
    expect(j.zapnuto).toMatchObject({ rezervace: false, predprodej: false, spolujizda: false });
    await nastav(VSE);
    expect((await fetch(t.base + '/rezervace/')).status).toBe(200);
  });

  it('vypnutý kvíz a infokanál: veřejně „není zapnutá“, zmizí z menu a úvodu, správa dál funguje', async () => {
    const anonym = new Prohlizec(t.base);
    const pred = await anonym.get('/sluzby');
    expect(pred.text).toContain('href="/infokanal"');
    await nastav({ ...VSE, kviz: false, infokanal: false });
    const kviz = await anonym.get('/kviz');
    expect(kviz.res.status).toBe(404);
    expect(kviz.text).toContain('Tato služba není v obci zapnutá');
    expect((await anonym.get('/infokanal')).res.status).toBe(404);
    expect((await anonym.get('/infokanal/odber', false)).res.status).toBe(404);
    const uvod = await anonym.get('/sluzby');
    expect(uvod.text).not.toContain('href="/infokanal"');
    expect(uvod.text).not.toContain('href="/kviz"');
    // správa zůstává správci dostupná
    expect((await admin.get('/sprava/kviz')).res.status).toBe(200);
    expect((await admin.get('/infokanal/sprava')).res.status).toBe(200);
    const sprava = await admin.get('/sprava/moduly');
    expect(sprava.text).toContain('Vypnuto');
    await nastav(VSE);
    expect((await anonym.get('/kviz')).res.status).toBe(200);
    expect((await anonym.get('/infokanal')).res.status).toBe(200);
  });

  it('Správa → Moduly obce jen pro admina', async () => {
    const spravce = await prihlasSRoli(t, '777100002', ['spravce']);
    expect((await spravce.get('/sprava/moduly')).res.status).toBe(403);
    const anonym = new Prohlizec(t.base);
    const r = await anonym.get('/sprava/moduly', false);
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get('location')).toContain('/prihlaseni');
    const r2 = await fetch(t.base + '/sprava/moduly', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kviz=0',
      redirect: 'manual',
    });
    expect(r2.status).toBe(403); // bez CSRF
    expect((await admin.get('/sprava')).text).toContain('/sprava/moduly');
  });
});

describe('soukromý chat týmu (/chat)', () => {
  it('nepřihlášený → přihlášení; cizí účet → 404 (bez stopy v odkazech); povolený telefon → proxy a odkaz v patičce', async () => {
    const anonym = new Prohlizec(t.base);
    const r0 = await anonym.get('/chat/', false);
    expect(r0.res.status).toBe(302);
    expect(r0.res.headers.get('location')).toBe('/prihlaseni?zpet=%2Fchat%2F');
    expect((await anonym.get('/')).text).not.toContain('href="/chat/"');

    const cizi = await prihlasSRoli(t, '777100002', ['web']);
    expect((await cizi.get('/chat/', false)).res.status).toBe(404);
    expect((await cizi.get('/chat/api/zpravy', false)).res.status).toBe(404);
    expect((await cizi.get('/')).text).not.toContain('href="/chat/"');

    // admin má telefon 777100001 = v seznamu (s mezerami v env)
    expect((await admin.get('/')).text).toContain('href="/chat/"');
    const r1 = await admin.get('/chat', false);
    expect(r1.res.status).toBe(301);
    expect(r1.res.headers.get('location')).toBe('/chat/');
    const r2 = await admin.get('/chat/api/zpravy?od=x');
    expect(r2.res.status).toBe(200);
    expect(r2.text).toBe('APLIKACE GET /chat/api/zpravy?od=x');
    expect(posledni().hlavicky['x-forwarded-prefix']).toBe('/chat');
    // i bez Accept text/html (fetch ze stránky) rozhoduje sezení
    const r3 = await admin.post('/chat/api/zprava', { a: '1' });
    expect(r3.res.status).toBe(200);
    expect(posledni().metoda).toBe('POST');
  });
});
