// Sestavení aplikace: Fastify + Postgres + šablony + sezení + moduly. Nic tu neposlouchá — to dělá index.ts
// (a testy, které si aplikaci sestaví s vlastní konfigurací).
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import type { Env } from './config/env.js';
import { nactiObec, type ObecProfil } from './config/obec.js';
import { vytvorDb, pockejNaDb, type Db } from './db/index.js';
import { migruj } from './db/migrate.js';
import type { Uzivatel } from './db/types.js';
import type { UlozenyVzhled } from './moduly/web/vzhled.js';
import { vytvorT, type T } from './i18n/index.js';
import { vytvorLogger } from './lib/logger.js';
import type { FastifyBaseLogger } from 'fastify';
import { OtpSluzba } from './lib/otp.js';
import { vytvorLimit, type Limit } from './lib/limit.js';
import { KonzoleMail, SmtpMail, type MailPoskytovatel } from './lib/mail.js';
import { vytvorSmsPoskytovatele } from './lib/sms/index.js';
import type { SmsPoskytovatel } from './lib/sms/typy.js';
import { PostgresSessionStore } from './web/sezeni.js';
import nahravani from './web/nahravani.js';
import souboryRoutes from './web/soubory.js';
import ikonyRoutes from './web/ikony.js';
import { SouboroveUloziste } from './lib/soubory.js';
import sablony from './web/sablony.js';
import hlavicky from './web/hlavicky.js';
import webRoutes from './web/routes.js';
import uctyModul from './moduly/ucty/index.js';
import infokanalModul from './moduly/infokanal/index.js';
import deskaModul from './moduly/deska/index.js';
import webModul from './moduly/web/index.js';
import webMapa from './moduly/web/mapa.js';

/** vrátí true, pokud požadavek obsloužil (odpověď odeslána) */
export type Zachytavac404 = (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>;

export interface AppVolby {
  env: Env;
  obec?: ObecProfil;
  db?: Db;
  sms?: SmsPoskytovatel;
  mail?: MailPoskytovatel;
  log?: FastifyBaseLogger;
  /** spustit migrace při startu (výchozí ano) */
  migrovat?: boolean;
  /** spouštět crony a rozesílací worker (výchozí ano; testy vypínají) */
  planovac?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    obec: ObecProfil;
    db: Db;
    t: T;
    sms: SmsPoskytovatel;
    mail: MailPoskytovatel;
    otp: OtpSluzba;
    /** limity požadavků podle IP: odeslání kódu, ověření kódu, přihlášení heslem */
    limity: { poslat: Limit; overit: Limit; heslo: Limit };
    sessionStore: PostgresSessionStore;
    soubory: SouboroveUloziste;
    /** moduly sem přidávají hledání obsahu pro neznámé adresy (stránky webu, přesměrování starých URL) */
    zachytavace404: Zachytavac404[];
    /** moduly sem přidávají data pro layout (menu, vzhled, patička) — volá se při každém vykreslení stránky */
    dataLayoutu: ((req: FastifyRequest) => Promise<Record<string, unknown>>)[];
  }
  interface FastifyRequest {
    uzivatel: Uzivatel | null;
  }
  interface Session {
    uzivatelId?: string;
    flash?: { typ: 'ok' | 'chyba' | 'info'; text: string; odkaz?: { url: string; text: string } } | null;
    oidc?: { state: string; nonce: string; verifier: string; zpet?: string };
    idToken?: string;
    cekaSouhlas?: { interakce: string; uzivatelId: string };
    odber?: { odberatelId: string; do: number };
    /** čerstvé ověření pro citlivé změny účtu platí do (ms) */
    overenoDo?: number;
    /** náhled vzhledu webu (správa) — platí jen pro toto sezení, dokud ho správce nepoužije nebo nezruší */
    nahledVzhledu?: UlozenyVzhled | null;
  }
}

export async function vytvorApp(volby: AppVolby): Promise<FastifyInstance> {
  const { env } = volby;
  const log = volby.log ?? vytvorLogger(env.LOG_LEVEL, env.NODE_ENV);
  const app = Fastify({
    loggerInstance: log,
    // jen počet skoků: s `true` by req.ip byla nejlevější (klientem podvrhnutelná) adresa z X-Forwarded-For
    trustProxy: (_adresa: string, skok: number) => skok < env.TRUST_PROXY_HOPS,
    disableRequestLogging: env.NODE_ENV !== 'development',
  });

  const obec = volby.obec ?? nactiObec(path.resolve(env.OBEC_YML));
  const db = volby.db ?? vytvorDb(env.DATABASE_URL);
  await pockejNaDb(db);
  if (volby.migrovat !== false) await migruj(db, log);

  app.decorate('env', env);
  app.decorate('obec', obec);
  app.decorate('db', db);
  app.decorate('t', vytvorT('cs'));
  app.decorate('sms', volby.sms ?? vytvorSmsPoskytovatele(env, log));
  app.decorate('mail', volby.mail ?? vytvorMail(env, log));
  app.decorate('otp', new OtpSluzba(db, env.SESSION_SECRET));
  app.decorate('limity', {
    poslat: vytvorLimit(10, 15),
    overit: vytvorLimit(20, 15),
    heslo: vytvorLimit(20, 15),
  });
  const store = new PostgresSessionStore(db);
  app.decorate('sessionStore', store);
  app.decorateRequest('uzivatel', null);
  app.decorate('soubory', new SouboroveUloziste(db, env.DATA_DIR));
  app.decorate('zachytavace404', [] as Zachytavac404[]);
  app.decorate('dataLayoutu', [] as ((req: FastifyRequest) => Promise<Record<string, unknown>>)[]);

  const https = env.BASE_URL.startsWith('https://');
  await app.register(hlavicky);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: env.SESSION_SECRET,
    cookieName: 'mo_sezeni',
    store,
    saveUninitialized: false,
    rolling: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: https, path: '/', maxAge: 30 * 24 * 3600_000 },
  });
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/session',
    // token z formuláře (i multipart — pole převádí web/nahravani.ts) nebo z hlavičky (fetch z editoru)
    getToken: (req) => {
      const b = req.body as Record<string, unknown> | undefined;
      const z = b && typeof b === 'object' ? b._csrf : undefined;
      if (typeof z === 'string') return z;
      const h = req.headers['x-csrf-token'];
      return typeof h === 'string' ? h : '';
    },
  });
  await app.register(fastifyFormbody);
  await app.register(nahravani);
  await app.register(fastifyStatic, {
    root: path.resolve(import.meta.dirname, '..', 'public'),
    prefix: '/static/',
    maxAge: env.NODE_ENV === 'production' ? '1d' : 0,
  });
  // písma self-hosted z balíčků @fontsource (jen soubory písem, žádné CDN)
  await app.register(fastifyStatic, {
    root: path.resolve(import.meta.dirname, '..', 'node_modules', '@fontsource'),
    prefix: '/static/fonty/',
    decorateReply: false,
    allowedPath: (p) => /^\/[a-z0-9-]+\/files\/[a-z0-9-]+\.woff2$/.test(p),
    maxAge: '365d',
    immutable: true,
  });
  // knihovny pro prohlížeč vendorované přes npm (žádné CDN): editor Quill
  await app.register(fastifyStatic, {
    root: path.resolve(import.meta.dirname, '..', 'node_modules', 'quill', 'dist'),
    prefix: '/static/vendor/quill/',
    decorateReply: false,
    maxAge: env.NODE_ENV === 'production' ? '7d' : 0,
  });
  await app.register(sablony);

  // přihlášený uživatel ze sezení (jeden dotaz na požadavek; statické soubory a OIDC endpointy přeskočit)
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/static/') || req.url.startsWith('/healthz')) return;
    const id = req.session?.uzivatelId;
    if (!id) return;
    const u = await db.selectFrom('uzivatele').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u || u.blokovan_at) {
      await req.session.destroy();
      return;
    }
    req.uzivatel = u;
  });

  // CSRF pro všechny formuláře (POST) kromě OIDC endpointů a webhooků, které mají vlastní ochranu
  app.addHook('preHandler', (req, reply, done) => {
    const cesta = req.url.split('?')[0] ?? '';
    if (
      req.method !== 'POST' ||
      /^\/oidc\/(?!interaction\/)/.test(cesta) ||
      cesta.startsWith('/api/') ||
      cesta.startsWith('/webhook/')
    ) {
      return done();
    }
    app.csrfProtection(req, reply, done);
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      for (const z of app.zachytavace404) if (await z(req, reply)) return reply;
    }
    if (req.headers.accept?.includes('text/html') || req.method === 'GET') {
      return reply
        .code(404)
        .view('chyba', { status: 404, nadpis: app.t('app.chyba_404'), text: app.t('app.chyba_404_text') });
    }
    return reply.code(404).send({ chyba: 'not_found' });
  });

  app.setErrorHandler(async (err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e.code === 'FST_CSRF_INVALID_TOKEN' || e.code === 'FST_CSRF_MISSING_SECRET') {
      req.session.flash = { typ: 'chyba', text: app.t('app.csrf') };
      return reply
        .code(403)
        .view('chyba', { status: 403, nadpis: app.t('app.chyba_403'), text: app.t('app.csrf') });
    }
    // neplatný identifikátor v adrese nebo formuláři (ne-UUID → Postgres 22P02 „invalid input syntax“) = nenalezeno
    const status = e.code === '22P02' ? 404 : e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) req.log.error({ err: e, url: req.url }, 'neošetřená chyba');
    if (status === 403) {
      return reply
        .code(403)
        .view('chyba', { status: 403, nadpis: app.t('app.chyba_403'), text: app.t('app.chyba_403_text') });
    }
    if (status === 404) {
      return reply
        .code(404)
        .view('chyba', { status: 404, nadpis: app.t('app.chyba_404'), text: app.t('app.chyba_404_text') });
    }
    if (status >= 500) {
      return reply
        .code(500)
        .view('chyba', { status: 500, nadpis: app.t('app.chyba_500'), text: app.t('app.chyba_500_text') });
    }
    return reply.code(status).send({ chyba: e.message });
  });

  await app.register(webRoutes);
  await app.register(souboryRoutes);
  await app.register(ikonyRoutes);
  if (obec.moduly.ucty) await app.register(uctyModul);
  if (obec.moduly.infokanal) await app.register(infokanalModul, { planovac: volby.planovac !== false });
  if (obec.moduly.deska) await app.register(deskaModul);
  if (obec.moduly.web) {
    await app.register(webModul, { planovac: volby.planovac !== false });
    await app.register(webMapa);
  }

  app.addHook('onClose', async () => {
    if (!volby.db) await db.destroy();
  });

  return app;
}

function vytvorMail(env: Env, log: FastifyBaseLogger): MailPoskytovatel {
  if (env.MAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST) throw new Error('MAIL_PROVIDER=smtp vyžaduje SMTP_HOST');
    return new SmtpMail({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
    });
  }
  return new KonzoleMail(log);
}
