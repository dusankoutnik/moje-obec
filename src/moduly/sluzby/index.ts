// Moduly obce: služba zapnutí (app.moduly), hlídání vypnutých platformních modulů, Administrace → Moduly obce,
// veřejné GET /api/moduly, proxy aplikací (/rezervace, /eknihy) a hlavička webu pro aplikace (/api/interni/hlavicka).
// Registruje se vždy (jádro platformy).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { zaregistrujHlavicku } from './hlavicka.js';
import { prihlasenyZeSezeni, zaregistrujProxy } from './proxy.js';
import { KLICE_MODULU, MODULY, ModulySluzba, podCestou, type KlicModulu, type StavModulu } from './sluzba.js';
import { nazevInfokanalu } from '../infokanal/nazev.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** moduly obce zapínatelné ve správě (rezervace, předprodej, spolujízda, eKnihy, infokanál, kvíz) */
    moduly: ModulySluzba;
  }
}

/** veřejné stránky platformních modulů, které při vypnutí modulu nejsou k dispozici (správa zůstává) */
const VYJIMKY: Partial<Record<KlicModulu, string[]>> = {
  // správa (aby šel modul zase zapnout a pracovat s daty) a odhlášení odběru odkazem z e-mailu (GDPR — vždy)
  infokanal: ['/infokanal/sprava', '/infokanal/odhlasit'],
};

export function nazevModulu(app: FastifyInstance, klic: KlicModulu): string {
  if (klic === 'infokanal') return nazevInfokanalu(app);
  return app.t(`moduly_obce.nazev_${klic}`);
}

/** stránka „Tato služba není v obci zapnutá“ (404) */
export async function strankaVypnuto(app: FastifyInstance, _req: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).view('chyba', {
    status: 404,
    titulek: app.t('moduly_obce.vypnuto_nadpis'),
    nadpis: app.t('moduly_obce.vypnuto_nadpis'),
    text: app.t('moduly_obce.vypnuto_text'),
  });
}

/** stránka „Služba je dočasně nedostupná“ (502) — aplikace za proxy neodpovídá */
export async function strankaNedostupne(app: FastifyInstance, _req: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(502)
    .header('retry-after', '60')
    .view('chyba', {
      status: 502,
      titulek: app.t('moduly_obce.nedostupne_nadpis'),
      nadpis: app.t('moduly_obce.nedostupne_nadpis'),
      text: app.t('moduly_obce.nedostupne_text'),
    });
}

/** Služba modulů — vytvoří se v app.ts před sezením (proxy ji potřebuje v onRequest) */
export function vytvorModuly(app: FastifyInstance) {
  const sluzba = new ModulySluzba(app.db, app.obec, app.env);
  app.decorate('moduly', sluzba);
  zaregistrujProxy(
    app,
    sluzba,
    {
      vypnuto: (req, reply) => strankaVypnuto(app, req, reply),
      nedostupne: (req, reply) => strankaNedostupne(app, req, reply),
    },
    prihlasenyZeSezeni(app.db, app.env.SESSION_SECRET),
  );
}

export function popisyProApi(app: FastifyInstance, stav: StavModulu) {
  return MODULY.filter((m) => !m.mimoListu).map((m) => ({
    klic: m.klic,
    nazev: nazevModulu(app, m.klic),
    url: m.url,
    zapnuto: stav[m.klic],
    ...(m.rodic ? { rodic: m.rodic } : {}),
  }));
}

/** stav jen modulů horní lišty (tvar /api/moduly zafixovaný s aplikacemi — doplňky webu jako počasí v něm nejsou) */
function proListu(stav: StavModulu): Partial<StavModulu> {
  const v: Partial<StavModulu> = {};
  for (const m of MODULY) if (!m.mimoListu) v[m.klic] = stav[m.klic];
  return v;
}

async function sluzbyModul(app: FastifyInstance) {
  const t = app.t;
  const admin = vyzadujRoli('admin');

  // vypnutý platformní modul: veřejné stránky → „služba není zapnutá“
  const hlidane = MODULY.filter((m) => m.druh === 'platforma' && app.moduly.dostupny(m.klic));
  if (hlidane.length) {
    app.addHook('preHandler', async (req, reply) => {
      const cesta = req.url.split('?')[0] ?? '';
      const m = hlidane.find((x) => x.cesty.some((p) => podCestou(cesta, p)));
      if (!m) return;
      if ((VYJIMKY[m.klic] ?? []).some((p) => podCestou(cesta, p))) return;
      if (await app.moduly.zapnuto(m.klic)) return;
      return strankaVypnuto(app, req, reply);
    });
  }

  // hlavička, menu a patička webu pro aplikace za proxy (jednotný vzhled) — interní API s x-api-secret
  zaregistrujHlavicku(app);

  // veřejný přehled modulů pro aplikace (horní lišta) — jen názvy, adresy a stav
  app.get('/api/moduly', async (_req, reply) => {
    const stav = await app.moduly.stav();
    return (
      reply
        .header('cache-control', 'public, max-age=30')
        .header('access-control-allow-origin', '*')
        // tvar zafixovaný s aplikacemi (lišta): všech šest modulů s příznakem `zapnuto`; Obec a Můj účet si
        // aplikace přidávají samy
        .send({ moduly: popisyProApi(app, stav), zapnuto: proListu(stav) })
    );
  });

  app.get('/sprava/moduly', { preHandler: admin }, async (_req, reply) => {
    const nastaveno = await app.moduly.nastaveno();
    const stav = await app.moduly.stav();
    const radky = MODULY.map((m) => ({
      klic: m.klic,
      nazev: nazevModulu(app, m.klic),
      popis: t(`moduly_obce.popis_${m.klic}`),
      url: m.url,
      rodic: m.rodic ? nazevModulu(app, m.rodic) : null,
      dostupny: app.moduly.dostupny(m.klic),
      nedostupnyDuvod:
        m.druh === 'aplikace'
          ? t('moduly_obce.nedostupny_aplikace', {
              promenna: m.klic === 'eknihy' ? 'APLIKACE_EKNIHY_URL' : 'APLIKACE_REZERVACE_URL',
            })
          : t('moduly_obce.nedostupny_platforma', { klic: m.klic }),
      nastaveno: nastaveno[m.klic],
      zapnuto: stav[m.klic],
      sprava:
        m.klic === 'infokanal'
          ? '/infokanal/sprava'
          : m.klic === 'kviz'
            ? '/sprava/kviz'
            : m.klic === 'pocasi'
              ? '/sprava/web/vzhled'
              : null,
    }));
    return reply.view('sprava/moduly', { titulek: t('moduly_obce.titulek'), radky });
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/sprava/moduly',
    { preHandler: admin },
    async (req, reply) => {
      const b = req.body ?? {};
      const zmeny: Partial<StavModulu> = {};
      for (const k of KLICE_MODULU) {
        if (!app.moduly.dostupny(k)) continue;
        const v = b[k];
        zmeny[k] = (Array.isArray(v) ? v.at(-1) : v) === '1';
      }
      const zmeneno = await app.moduly.uloz(zmeny, { uzivatelId: req.uzivatel!.id, ip: req.ip });
      const pocet = Object.keys(zmeneno).length;
      req.session.flash = pocet
        ? { typ: 'ok', text: t('moduly_obce.ulozeno', { n: pocet }) }
        : { typ: 'info', text: t('moduly_obce.beze_zmeny') };
      return reply.redirect('/sprava/moduly', 303);
    },
  );
}

export default fp(sluzbyModul, { name: 'sluzbyModul' });
