// Modul „web“: úzký redakční systém obecního webu — stránky (menu), aktuality, akce, fotogalerie, dokumenty,
// dotace s publicitou dárců, videa (vlastní i YouTube/Vimeo bez načítání cizích serverů předem), hledání,
// přesměrování starých adres, vzhled podle obce.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Cron } from 'croner';
import fp from 'fastify-plugin';
import { ObsahSluzba } from './obsah.js';
import { DokumentySluzba, DotaceSluzba, GalerieSluzba, PresmerovaniSluzba } from './dalsi.js';
import { VzhledSluzba } from './vzhled.js';
import { ExterniKalendar } from './akce-externi.js';
import { VideaSluzba } from './videa.js';
import { AkcePropojeniSluzba } from './akce-propojeni.js';
import webSpravaAkce from './sprava-akce.js';
import webVerejne from './verejne.js';
import webSprava from './sprava.js';
import webSpravaDalsi from './sprava-dalsi.js';
import webSpravaVidea from './sprava-videa.js';
import webKontaktObce from './kontakt-obce.js';
import { upozorniNaKonecDotaci, zalozVychoziMenu } from './udrzba.js';
import { jeVelikost } from './pisma.js';
import { maRoli } from '../ucty/sluzba.js';
import { bezpecnyNavrat } from '../../lib/navrat.js';
import obyvateleRoutes from './obyvatele.js';

export const COOKIE_VELIKOST = 'mo_velikost';

export interface WebSluzby {
  obsah: ObsahSluzba;
  galerie: GalerieSluzba;
  dokumenty: DokumentySluzba;
  dotace: DotaceSluzba;
  presmerovani: PresmerovaniSluzba;
  vzhled: VzhledSluzba;
  /** akce sálu, hřišť a předprodeje z rezervačního systému */
  kalendar: ExterniKalendar;
  /** propojení akcí webu s termíny v rezervacích (koncepty, návrhy, změny termínu) */
  propojeni: AkcePropojeniSluzba;
  videa: VideaSluzba;
}

declare module 'fastify' {
  interface FastifyInstance {
    web: WebSluzby;
    webUvod?: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
  }
}

async function webModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const obsah = new ObsahSluzba(app.db);
  const kalendar = new ExterniKalendar(app.env.REZERVACE_KALENDAR_URL, app.log);
  const s: WebSluzby = {
    obsah,
    galerie: new GalerieSluzba(app.db),
    dokumenty: new DokumentySluzba(app.db),
    dotace: new DotaceSluzba(app.db),
    presmerovani: new PresmerovaniSluzba(app.db),
    vzhled: new VzhledSluzba(app.db, app.obec),
    kalendar,
    propojeni: new AkcePropojeniSluzba(app.db, obsah, kalendar, () => ({
      koncepty: app.obec.web.akce_koncepty,
      textPredprodeje: app.t('propojeni.koncept_predprodej'),
    })),
    videa: new VideaSluzba(app.db, app.soubory),
  };
  app.decorate('web', s);
  await zalozVychoziMenu(app);
  // vzhled načíst hned — název infokanálu z něj berou i e-maily a texty bez požadavku (src/moduly/infokanal/nazev.ts)
  await s.vzhled.nacti().catch(() => undefined);

  // menu, vzhled (případně náhled ze sezení), velikost písma návštěvníka, fotka pozadí a pás dárců
  app.dataLayoutu.push(async (req) => {
    const nahled =
      req.session?.nahledVzhledu && maRoli(req.uzivatel, 'provozovatel') ? req.session.nahledVzhledu : null;
    const vzhled = nahled
      ? await s.vzhled.sestav({ ...(await s.vzhled.nacti()).ulozeno, ...nahled })
      : await s.vzhled.nacti();
    const cookie = req.cookies?.[COOKIE_VELIKOST];
    const velikost = jeVelikost(cookie) ? cookie : vzhled.velikost;
    const fotky = vzhled.pozadi;
    const prvni =
      vzhled.pozadiRezim === 'pevne'
        ? (vzhled.pozadiPevne ?? fotky[0] ?? '')
        : (fotky[Math.floor(Math.random() * fotky.length)] ?? '');
    return {
      menu: await s.obsah.menu(),
      vzhled,
      nahledVzhledu: !!nahled,
      velikost,
      pozadiPrvni: prvni || vzhled.fotoUrl,
      pozadiStridat: vzhled.pozadiRezim === 'stridani' && fotky.length > 1 ? fotky : [],
      dotacePaticka: await s.dotace.aktivni(true),
    };
  });

  // velikost písma pro návštěvníka (cookie na rok); funguje i bez JS — odkaz/formulář s návratem zpět
  app.get<{ Querystring: { v?: string; zpet?: string } }>('/velikost', async (req, reply) => {
    const v = req.query.v;
    if (jeVelikost(v))
      reply.setCookie(COOKIE_VELIKOST, v, {
        path: '/',
        maxAge: 365 * 86400,
        sameSite: 'lax',
        httpOnly: true,
      });
    const zpet = String(req.query.zpet ?? '/');
    return reply.header('cache-control', 'no-store').redirect(bezpecnyNavrat(zpet));
  });

  // „Správa“ se jmenuje Administrace (22. 10. 2026); adresa zůstává /sprava — /administrace* trvale přesměrovat
  const naSpravu = async (req: FastifyRequest, reply: FastifyReply) =>
    reply.redirect('/sprava' + req.url.slice('/administrace'.length), 301);
  app.get('/administrace', naSpravu);
  app.get('/administrace/*', naSpravu);

  await app.register(webVerejne, s);
  await app.register(webSprava, s);
  await app.register(webSpravaDalsi, s);
  await app.register(webSpravaVidea, s);
  await app.register(webKontaktObce);
  await app.register(obyvateleRoutes);
  await app.register(webSpravaAkce, s);

  if (volby.planovac) {
    const job = new Cron('0 8 * * *', { timezone: 'Europe/Prague' }, async () => {
      await upozorniNaKonecDotaci(app).catch((e) => app.log.warn({ err: e }, 'dotace upozornění'));
    });
    // termíny z rezervací → koncepty akcí ke zpracování (idempotentní)
    const sync = new Cron('*/10 * * * *', { timezone: 'Europe/Prague', protect: true }, async () => {
      await s.propojeni
        .synchronizuj()
        .catch((e) => app.log.warn({ err: e }, 'synchronizace akcí z rezervací'));
    });
    app.addHook('onClose', async () => {
      job.stop();
      sync.stop();
    });
  }
}

export default fp(webModul, { name: 'webModul' });
