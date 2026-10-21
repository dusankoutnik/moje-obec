// Společná výbava testů: aplikace na volném portu s čistou testovací DB, konzolové SMS/e-maily, cookie jar pro fetch.
import { createServer } from 'node:net';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { vytvorApp } from '../src/app.js';
import { nactiEnv } from '../src/config/env.js';
import { obecZObjektu } from '../src/config/obec.js';
import { vytvorDb, type Db } from '../src/db/index.js';
import { KonzoleSms } from '../src/lib/sms/konzole.js';
import { KonzoleMail } from '../src/lib/mail.js';
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://platforma:platforma@localhost:5432/platforma_test';

export function volnyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export const testovaciObec = obecZObjektu({
  obec: {
    nazev: 'Obec Testov',
    kratky_nazev: 'Testov',
    casti: ['Testov', 'Dolní Testov'],
    kontakt: { email: 'obec@testov.cz' },
  },
  moduly: { ucty: true, infokanal: true, deska: true, web: true, kviz: true },
  texty: { nazev_infokanalu: 'TestKanál', sms_prefix: 'TESTOV: ' },
});

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  base: string;
  sms: KonzoleSms;
  mail: KonzoleMail;
  zavri(): Promise<void>;
}

/** testy smějí mazat jen databázi, jejíž název končí na _test (ochrana před překlepem v TEST_DATABASE_URL) */
export function jeTestovaciDb(url: string): boolean {
  try {
    const jmeno = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return /_test$/.test(jmeno);
  } catch {
    return false;
  }
}

// vyprázdní schéma (migrace si ho při startu aplikace znovu postaví)
export async function vycistiDb(db: Db, url = TEST_DB_URL) {
  if (!jeTestovaciDb(url))
    throw new Error(
      `Testy mažou celé schéma — databáze v TEST_DATABASE_URL musí končit na _test (${url.replace(/\/\/[^@]*@/, '//…@')})`,
    );
  const r = await sql<{ db: string }>`SELECT current_database() AS db`.execute(db);
  if (!/_test$/.test(r.rows[0]!.db))
    throw new Error(`Připojená databáze ${r.rows[0]!.db} nekončí na _test — schéma nesmažu`);
  await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`.execute(db);
}

export async function spustTestApp(volby: { vycistit?: boolean } = {}): Promise<TestApp> {
  const port = await volnyPort();
  const base = `http://127.0.0.1:${port}`;
  const env = nactiEnv({
    NODE_ENV: 'test',
    BASE_URL: base,
    INTERNAL_BASE_URL: base,
    DATABASE_URL: TEST_DB_URL,
    SESSION_SECRET: 'a'.repeat(64),
    OIDC_COOKIE_SECRET: 'b'.repeat(64),
    OIDC_PLATFORMA_SECRET: 'c'.repeat(32),
    OTP_DEV_ZOBRAZIT: '1',
    OTP_COOLDOWN_S: '0',
    LOG_LEVEL: 'silent',
    DATA_DIR: '/tmp/platforma-test-data',
    IK_SMS_INTERVAL_MIN_MS: '1',
    IK_SMS_INTERVAL_MAX_MS: '2',
    IK_EMAIL_INTERVAL_MS: '1',
    // kvíz: malý testovací balík (vymyšlená data), ne skutečná banka z kviz-otazky/
    KVIZ_VEREJNE: new URL('./fixtures/kviz', import.meta.url).pathname,
  });
  const db = vytvorDb(TEST_DB_URL, 4);
  if (volby.vycistit !== false) await vycistiDb(db);
  const sms = new KonzoleSms();
  const mail = new KonzoleMail();
  const log = pino({ level: process.env.LADENI ? 'error' : 'silent' }) as unknown as FastifyBaseLogger;
  const app = await vytvorApp({ env, obec: testovaciObec, db, sms, mail, log, planovac: false });
  await app.listen({ port, host: '127.0.0.1' });
  return {
    app,
    db,
    base,
    sms,
    mail,
    async zavri() {
      await app.close();
      await db.destroy();
    },
  };
}

// Minimální prohlížeč: cookie jar + ruční sledování přesměrování (fetch je sdílí nerad).
export class Prohlizec {
  private cookies = new Map<string, string>();
  /** hlavičky navíc ke každému požadavku (např. X-Forwarded-For pro testy limitů) */
  hlavicky: Record<string, string> = {};
  constructor(private base: string) {}

  private hlavickaCookie() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private ulozCookies(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, ...v] = pair!.split('=');
      const expires = attrs.find((a) => a.trim().toLowerCase().startsWith('expires='))?.split('=')[1];
      if (expires && new Date(expires).getTime() < Date.now()) this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), v.join('='));
    }
  }

  async get(url: string, sledovat = true): Promise<{ res: Response; text: string; url: string }> {
    let aktualni = url.startsWith('http') ? url : this.base + url;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(aktualni, {
        headers: { ...this.hlavicky, cookie: this.hlavickaCookie(), accept: 'text/html' },
        redirect: 'manual',
      });
      this.ulozCookies(res);
      const loc = res.headers.get('location');
      if (sledovat && loc && res.status >= 300 && res.status < 400) {
        aktualni = new URL(loc, aktualni).href;
        continue;
      }
      return { res, text: await res.text(), url: aktualni };
    }
    throw new Error('příliš mnoho přesměrování');
  }

  async postFormData(
    url: string,
    data: Record<string, string | string[]>,
    soubory: TestSoubor[],
    sledovat = true,
  ): Promise<{ res: Response; text: string; url: string }> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(data)) (Array.isArray(v) ? v : [v]).forEach((x) => fd.append(k, x));
    for (const s of soubory)
      fd.append(s.pole, new Blob([s.data], { type: s.typ ?? 'application/octet-stream' }), s.nazev);
    const res = await fetch(url.startsWith('http') ? url : this.base + url, {
      method: 'POST',
      headers: { ...this.hlavicky, cookie: this.hlavickaCookie(), accept: 'text/html' },
      body: fd,
      redirect: 'manual',
    });
    this.ulozCookies(res);
    const loc = res.headers.get('location');
    if (sledovat && loc && res.status >= 300 && res.status < 400)
      return this.get(new URL(loc, this.base + url).href);
    return { res, text: await res.text(), url };
  }

  async post(url: string, data: Record<string, string | string[]>, sledovat = true) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) (Array.isArray(v) ? v : [v]).forEach((x) => body.append(k, x));
    const res = await fetch(url.startsWith('http') ? url : this.base + url, {
      method: 'POST',
      headers: {
        ...this.hlavicky,
        cookie: this.hlavickaCookie(),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
      },
      body,
      redirect: 'manual',
    });
    this.ulozCookies(res);
    const loc = res.headers.get('location');
    if (sledovat && loc && res.status >= 300 && res.status < 400)
      return this.get(new URL(loc, this.base + url).href);
    return { res, text: await res.text(), url };
  }
}

export interface TestSoubor {
  pole: string;
  nazev: string;
  data: Buffer | Uint8Array;
  typ?: string;
}

// formulář s nahráním souborů (multipart/form-data)
export async function postSoubory(
  p: Prohlizec,
  url: string,
  data: Record<string, string | string[]>,
  soubory: TestSoubor[],
  sledovat = true,
) {
  return p.postFormData(url, data, soubory, sledovat);
}

export function csrfZ(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('CSRF token nenalezen v HTML');
  return m[1]!;
}

// účet s rolí (vloží do DB) a přihlásí ho
export async function prihlasSRoli(t: TestApp, telefon: string, role: string[]) {
  const { normalizujTelefon } = await import('../src/lib/kontakty.js');
  const tel = normalizujTelefon(telefon)!;
  await t.db
    .insertInto('uzivatele')
    .values({ telefon: tel, email: null, heslo_hash: null, role: role as never, gdpr_souhlas_at: new Date() })
    .onConflict((oc) => oc.column('telefon').doUpdateSet({ role: role as never }))
    .execute();
  const p = new Prohlizec(t.base);
  await prihlasTelefonem(p, tel);
  return p;
}

export const MALE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 10 10]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

export function devKodZ(html: string): string {
  const m = /kód z SMS je (\d{6})/.exec(html);
  if (!m) throw new Error('vývojový kód nenalezen v HTML');
  return m[1]!;
}

// Projde přihlášení telefonem přes OIDC interakci (včetně GDPR souhlasu, je-li první). Vrací stránku po přihlášení.
export async function prihlasTelefonem(p: Prohlizec, telefon: string) {
  const inter = await p.get('/prihlaseni');
  if (!inter.url.includes('/oidc/interaction/')) throw new Error(`čekal jsem interakci, mám ${inter.url}`);
  const uid = inter.url.split('/oidc/interaction/')[1]!.split('/')[0];
  const kodStranka = await p.post(`/oidc/interaction/${uid}/telefon`, { _csrf: csrfZ(inter.text), telefon });
  const kod = devKodZ(kodStranka.text);
  let po = await p.post(`/oidc/interaction/${uid}/kod`, { _csrf: csrfZ(kodStranka.text), telefon, kod });
  if (po.text.includes('action="/oidc/interaction/' + uid + '/souhlas"')) {
    po = await p.post(`/oidc/interaction/${uid}/souhlas`, { _csrf: csrfZ(po.text), souhlas: 'ano' });
  }
  return po;
}
