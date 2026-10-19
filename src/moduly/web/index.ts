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
import webVerejne from './verejne.js';
import webSprava from './sprava.js';
import webSpravaDalsi from './sprava-dalsi.js';
import webSpravaVidea from './sprava-videa.js';
import { upozorniNaKonecDotaci, zalozVychoziMenu } from './udrzba.js';
import { jeVelikost } from './pisma.js';
import { maRoli } from '../ucty/sluzba.js';
import { bezpecnyNavrat } from '../../lib/navrat.js';

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
  videa: VideaSluzba;
}

declare module 'fastify' {
  interface FastifyInstance {
    web: WebSluzby;
    webUvod?: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;
  }
}

async function webModul(app: FastifyInstance, volby: { planovac: boolean }) {
  const s: WebSluzby = {
    obsah: new ObsahSluzba(app.db),
    galerie: new GalerieSluzba(app.db),
    dokumenty: new DokumentySluzba(app.db),
    dotace: new DotaceSluzba(app.db),
    presmerovani: new PresmerovaniSluzba(app.db),
    vzhled: new VzhledSluzba(app.db, app.obec),
    kalendar: new ExterniKalendar(app.env.REZERVACE_KALENDAR_URL, app.log),
    videa: new VideaSluzba(app.db, app.soubory),
  };
  app.decorate('web', s);
  await zalozVychoziMenu(app);

  // menu, vzhled (případně náhled ze sezení), velikost písma návštěvníka, fotka pozadí a pás dárců
  app.dataLayoutu.push(async (req) => {
    const nahled =
      req.session?.nahledVzhledu && maRoli(req.uzivatel, 'spravce') ? req.session.nahledVzhledu : null;
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

  await app.register(webVerejne, s);
  await app.register(webSprava, s);
  await app.register(webSpravaDalsi, s);
  await app.register(webSpravaVidea, s);

  if (volby.planovac) {
    const job = new Cron('0 8 * * *', { timezone: 'Europe/Prague' }, async () => {
      await upozorniNaKonecDotaci(app).catch((e) => app.log.warn({ err: e }, 'dotace upozornění'));
    });
    app.addHook('onClose', async () => job.stop());
  }
}

export default fp(webModul, { name: 'webModul' });
