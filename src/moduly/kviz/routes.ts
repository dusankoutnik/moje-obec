// Veřejná část kvízu. Vše jsou obyčejné formuláře (POST → přesměrování → GET), JavaScript jen přidává klávesy A–D.
// Nepřihlášený hráč = náhodný identifikátor v cookie mo_kviz; vzniká až kliknutím „Začít kvíz“ (nezbytná cookie
// pro funkci, kterou si návštěvník sám vyžádal). Přihlášený má skóre u účtu; anonymní skóre se k němu připojí.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { klicIp, vytvorLimit } from '../../lib/limit.js';
import type { Hrac, KvizSluzba } from './sluzba.js';
import { DELKA_KOLA } from './vyber.js';

export const KVIZ_COOKIE = 'mo_kviz';
const ROK_MS = 365 * 24 * 3600_000;

const jeOdkaz = (s: string) => /^https?:\/\/\S+$/i.test(s);

export default async function kvizRoutes(app: FastifyInstance, z: { sluzba: KvizSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const https = app.env.BASE_URL.startsWith('https://');
  // zakládání anonymních hráčů z jedné adresy (ochrana tabulky před zaplavením)
  const limitZalozeni = vytvorLimit(30, 15);

  const cookieVolby = { path: '/kviz', httpOnly: true, sameSite: 'lax' as const, secure: https };

  async function hrac(req: FastifyRequest, reply: FastifyReply): Promise<Hrac | null> {
    const cookieId = req.cookies[KVIZ_COOKIE] ?? null;
    const r = await sluzba.najdiHrace({ uzivatelId: req.uzivatel?.id ?? null, cookieId });
    if (r.smazatCookie) reply.clearCookie(KVIZ_COOKIE, cookieVolby);
    return r.hrac;
  }

  const spolecne = async (h: Hrac) => ({
    skore: await sluzba.skore(h),
    kolo: h.kolo,
    delkaKola: DELKA_KOLA,
  });

  app.get('/kviz', async (req, reply) => {
    const h = await hrac(req, reply);
    const kategorie = await sluzba.kategorie();
    const zvolene = h?.kategorie.length ? new Set(h.kategorie) : null;
    return reply.view('kviz/index', {
      titulek: t('kviz.titulek'),
      kategorie: kategorie.map((k) => ({ ...k, zvolena: !zvolene || zvolene.has(k.slug) })),
      hrac: h,
      rozehrano: !!h?.otazka_id,
      skore: h ? await sluzba.skore(h) : null,
    });
  });

  app.post<{ Body: { kategorie?: string | string[] } }>('/kviz/start', async (req, reply) => {
    let h = await hrac(req, reply);
    if (!h) {
      if (!limitZalozeni.zkus(klicIp(req.ip)))
        return reply
          .code(429)
          .header('retry-after', '900')
          .view('chyba', { status: 429, nadpis: t('app.chyba_429'), text: t('app.chyba_429_text') });
      h = await sluzba.zalozHrace(req.uzivatel?.id ?? null);
      if (!req.uzivatel) reply.setCookie(KVIZ_COOKIE, h.id, { ...cookieVolby, maxAge: ROK_MS / 1000 });
    }
    const k = req.body?.kategorie;
    await sluzba.zacni(h.id, (Array.isArray(k) ? k : k ? [k] : []).map(String).slice(0, 50));
    return reply.redirect('/kviz/otazka', 303);
  });

  app.get('/kviz/otazka', async (req, reply) => {
    let h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    if (h.odpoved_id) return reply.redirect('/kviz/vysledek', 303);
    if (!h.otazka_id) h = (await sluzba.dalsi(h.id)) ?? h;
    const otazka = await sluzba.rozehrana(h);
    return reply.view('kviz/otazka', {
      titulek: otazka ? t('kviz.otazka_titulek', { n: h.krok + 1 }) : t('kviz.titulek'),
      otazka,
      krok: h.krok + 1,
      skriptKviz: true,
      ...(await spolecne(h)),
    });
  });

  app.post<{ Body: { otazka?: string; odpoved?: string } }>('/kviz/odpoved', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    const r = await sluzba.odpovez(h.id, String(req.body?.otazka ?? ''), Number(req.body?.odpoved));
    return reply.redirect(r === 'ok' ? '/kviz/vysledek' : '/kviz/otazka', 303);
  });

  app.get('/kviz/vysledek', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    const v = await sluzba.vysledek(h);
    if (!v) return reply.redirect('/kviz/otazka', 303);
    return reply.view('kviz/vysledek', {
      titulek: v.spravne ? t('kviz.spravne') : t('kviz.spatne'),
      v,
      zdrojOdkaz: jeOdkaz(v.zdroj),
      skriptKviz: true,
      ...(await spolecne(h)),
    });
  });

  app.post('/kviz/dalsi', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    await sluzba.dalsi(h.id);
    return reply.redirect('/kviz/otazka', 303);
  });

  app.get('/kviz/reset', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    return reply.view('kviz/reset', { titulek: t('kviz.reset_titulek'), skore: await sluzba.skore(h) });
  });

  app.post('/kviz/reset', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    await sluzba.reset(h.id);
    req.session.flash = { typ: 'ok', text: t('kviz.reset_hotovo') };
    return reply.redirect('/kviz/otazka', 303);
  });

  app.get('/kviz/skore', async (req, reply) => {
    const h = await hrac(req, reply);
    if (!h) return reply.redirect('/kviz', 303);
    return reply.view('kviz/skore', {
      titulek: t('kviz.skore_titulek'),
      prehled: await sluzba.skorePoKategoriich(h),
      resetAt: h.reset_at,
    });
  });
}
