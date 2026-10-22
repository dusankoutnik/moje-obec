// Hlavička webu pro aplikace za proxy (rezervace, spolujízda, eKnihy): GET /api/interni/hlavicka → { verze, html }.
// `html` = celá stránka webu bez obsahu (layout.eta v režimu `shell`) se třemi zástupnými komentáři <!--HEAD-->,
// <!--PODMENU--> a <!--OBSAH-->, do kterých aplikace vloží svůj <title>/styly, podmenu a obsah. Přihlášeného a velikost
// písma platforma pozná z cookie prohlížeče, kterou aplikace přeposílá 1:1 (sezení mo_sezeni → req.uzivatel jako
// u každé stránky, mo_velikost → dataLayoutu webu). CSRF token odhlášení patří k tomu sezení, takže POST /odhlaseni
// z aplikace (stejná doména) projde. Kontrakt: docs/HLAVICKA-APLIKACI.md §1.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { overeniInternihoApi } from '../../lib/interni-api.js';
import { jeVlastniCesta } from '../../lib/navrat.js';
import { COOKIE_VELIKOST } from '../web/index.js';
import { MODULY } from './sluzba.js';

/** moduly, které mají v menu Moje obec vlastní položku k zvýraznění */
export const MODULY_HLAVICKY = ['rezervace', 'spolujizda', 'eknihy'] as const;
export type ModulHlavicky = (typeof MODULY_HLAVICKY)[number];

/** keš odpovědí podle (modul, aktivní cesta, uživatel, velikost písma) — 60 s, omezený počet položek */
const KES_MS = 60_000;
const KES_MAX = 400;

interface Polozka {
  at: number;
  verze: string;
  html: string;
}

export function zaregistrujHlavicku(app: FastifyInstance) {
  const kes = new Map<string, Polozka>();

  app.get<{ Querystring: { modul?: string; aktivni?: string } }>(
    '/api/interni/hlavicka',
    { preHandler: overeniInternihoApi(app.env.INTERNI_API_SECRET) },
    async (req, reply) => {
      const modul = String(req.query.modul ?? '');
      // neznámý modul = shell bez zvýrazněné položky (aplikace se nikdy nemá vracet k nouzovému layoutu kvůli překlepu)
      const koren = (MODULY_HLAVICKY as readonly string[]).includes(modul)
        ? MODULY.find((m) => m.klic === modul)!.url
        : '';
      const aktivniQ = typeof req.query.aktivni === 'string' ? req.query.aktivni : '';
      const cesta = (jeVlastniCesta(aktivniQ) ? aktivniQ.split('?')[0]! : koren || '/').slice(0, 300);
      const velikost = String(req.cookies?.[COOKIE_VELIKOST] ?? '');
      const klic = [modul, cesta, req.uzivatel?.id ?? '', velikost].join('|');
      const ted = Date.now();
      const hotova = kes.get(klic);
      if (hotova && ted - hotova.at < KES_MS) {
        return reply
          .header('cache-control', 'no-store')
          .header('x-hlavicka-kes', '1')
          .send({ verze: hotova.verze, html: hotova.html });
      }
      const html = await app.vykresli(
        req,
        reply,
        'layout',
        {
          shell: { modul, koren, cesta },
          cesta,
          cestaSDotazem: cesta,
          body: '<!--OBSAH-->',
        },
        { flash: false },
      );
      const verze = createHash('sha256').update(html).digest('hex').slice(0, 12);
      if (kes.size >= KES_MAX) kes.delete(kes.keys().next().value!);
      kes.set(klic, { at: ted, verze, html });
      return reply.header('cache-control', 'no-store').send({ verze, html });
    },
  );

  return { zahodKes: () => kes.clear() };
}
