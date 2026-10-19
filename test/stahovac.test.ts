// Stahovač importu proti lokálnímu HTTP serveru (žádná síť ven): přesměrování a neveřejné adresy, limity
// velikosti (Content-Length, proud, rozbalený gzip), opakování po 429, časový limit, volby příkazové řádky.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cisloVolby,
  jeVerejnaAdresa,
  vytvorStahovac,
  type VolbyStahovace,
} from '../src/moduly/web/import/stahovac.js';

let server: http.Server;
let base: string;
let pokusy429 = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const port = (server.address() as AddressInfo).port;
    switch (u.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ahoj');
      case '/gzip':
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync('<p>zabaleno</p>'));
      case '/na-ok':
        res.writeHead(302, { location: '/ok' });
        return res.end();
      case '/na-loopback':
        // jiný port = jiný původ, nepovolený → musí se odmítnout ještě před připojením
        res.writeHead(302, { location: `http://127.0.0.1:${port + 1}/tajne` });
        return res.end();
      case '/na-localhost':
        // jméno, které se přeloží na 127.0.0.1 → odmítne až kontrola po DNS
        res.writeHead(301, { location: `http://localhost:${port}/ok` });
        return res.end();
      case '/na-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      case '/na-file':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();
      case '/kruh': {
        const n = Number(u.searchParams.get('n') ?? 0);
        res.writeHead(302, { location: `/kruh?n=${n + 1}` });
        return res.end();
      }
      case '/velky-hlaseny':
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(10_000_000) });
        return res.end(); // tělo neposíláme — stahovač musí odmítnout podle hlavičky
      case '/velky-proud': {
        res.writeHead(200, { 'content-type': 'application/pdf' }); // bez Content-Length (chunked)
        const kus = Buffer.alloc(64 * 1024, 1);
        let poslano = 0;
        const dalsi = () => {
          while (poslano < 50 && res.write(kus)) poslano++;
          if (poslano < 50 && !res.destroyed) res.once('drain', dalsi);
          else res.end();
        };
        res.on('error', () => {});
        res.on('close', () => (poslano = 50));
        return dalsi();
      }
      case '/bomba':
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024))); // ~20 kB zabalených, 20 MB rozbalených
      case '/429':
        pokusy429++;
        if (pokusy429 < 2) {
          res.writeHead(429, { 'retry-after': '0' });
          return res.end();
        }
        res.writeHead(200);
        return res.end('po druhé');
      case '/visi':
        return; // nikdy neodpoví
      case '/soubor':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.alloc(3000, 2));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const stahovac = (navic: Partial<VolbyStahovace> = {}) =>
  vytvorStahovac({
    userAgent: 'test',
    rozestupMs: 0,
    pauzaMs: 10,
    timeoutMs: 2000,
    povolenePuvody: [base],
    ...navic,
  });

describe('stahovač importu', () => {
  it('stáhne text, rozbalí gzip a následuje přesměrování v rámci povoleného původu', async () => {
    const s = stahovac();
    expect(await s.text(`${base}/ok`)).toBe('ahoj');
    expect(await s.text(`${base}/gzip`)).toBe('<p>zabaleno</p>');
    expect(await s.text(`${base}/na-ok`)).toBe('ahoj');
  });

  it('bez povolení je i lokální server neveřejná adresa', async () => {
    const s = vytvorStahovac({ userAgent: 'test', rozestupMs: 0, pauzaMs: 10 });
    await expect(s.text(`${base}/ok`)).rejects.toThrow(/neveřejn/);
    expect(await s.soubor(`${base}/soubor`)).toBeNull();
  });

  it('přesměrování na loopback, localhost, metadata cloudu nebo file: se odmítne', async () => {
    const s = stahovac();
    for (const cesta of ['/na-loopback', '/na-localhost', '/na-metadata', '/na-file']) {
      await expect(s.text(`${base}${cesta}`), cesta).rejects.toThrow(/neveřejn|protokol/);
      expect(await s.soubor(`${base}${cesta}`), cesta).toBeNull();
    }
  });

  it('nekonečné přesměrování skončí po pěti skocích', async () => {
    await expect(stahovac().text(`${base}/kruh`)).rejects.toThrow(/přesměrování/);
  });

  it('nadměrné tělo: podle Content-Length, proudem i rozbalený gzip — bez načtení do paměti', async () => {
    const s = stahovac({ maxBajtuSouboru: 1024 * 1024, maxBajtuTextu: 1024 * 1024 });
    expect(await s.soubor(`${base}/velky-hlaseny`)).toBeNull();
    expect(await s.soubor(`${base}/velky-proud`)).toBeNull();
    await expect(s.text(`${base}/bomba`)).rejects.toThrow(/limit/);
    expect(s.stazeno).toBe(0);
    const ok = await s.soubor(`${base}/soubor`);
    expect(ok?.data.length).toBe(3000);
    expect(ok?.typ).toBe('image/png');
  });

  it('celkový limit stažených souborů', async () => {
    const s = stahovac({ limitBajtu: 5000 });
    expect(await s.soubor(`${base}/soubor`)).not.toBeNull();
    expect(await s.soubor(`${base}/soubor`)).toBeNull(); // zbývá 2000 B, soubor má 3000 B
    expect(s.stazeno).toBe(3000);
  });

  it('po 429 to zkusí znovu', async () => {
    pokusy429 = 0;
    expect(await stahovac().text(`${base}/429`)).toBe('po druhé');
    expect(pokusy429).toBe(2);
  });

  it('server, který neodpovídá, nezablokuje import (časový limit)', async () => {
    const s = stahovac({ timeoutMs: 150, pauzaMs: 1 });
    const zacatek = Date.now();
    expect(await s.soubor(`${base}/visi`)).toBeNull();
    expect(Date.now() - zacatek).toBeLessThan(5000);
  });

  it('neveřejné rozsahy adres', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'nesmysl',
    ])
      expect(jeVerejnaAdresa(ip), ip).toBe(false);
    for (const ip of ['185.21.98.1', '8.8.8.8', '2a00:1450:4014:80c::200e'])
      expect(jeVerejnaAdresa(ip), ip).toBe(true);
  });

  it('číselné volby příkazové řádky: nečíslo nevypne limit tiše', () => {
    expect(cisloVolby(undefined, 500, 'rozestup-ms')).toBe(500);
    expect(cisloVolby('250', 500, 'rozestup-ms')).toBe(250);
    for (const zle of ['abc', '', '-1', 'Infinity', 'NaN'])
      expect(() => cisloVolby(zle, 500, 'limit-mb'), zle).toThrow(/limit-mb/);
    expect(() => vytvorStahovac({ userAgent: 't', limitBajtu: NaN })).toThrow();
    expect(() => vytvorStahovac({ userAgent: 't', rozestupMs: NaN })).toThrow();
  });
});
