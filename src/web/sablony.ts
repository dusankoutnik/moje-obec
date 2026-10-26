// Šablony Eta: reply.view('soubor', data) vykreslí šablonu v layoutu se společnými daty (t, obec, uzivatel, csrf).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { formatujTelefon, maskujTelefon } from '../lib/kontakty.js';
import { filtrujMenu, type PolozkaMenu } from '../moduly/sluzby/sluzba.js';
import { maRoli } from '../moduly/ucty/sluzba.js';
import { nazevInfokanalu } from '../moduly/infokanal/nazev.js';

export const VIEWS_DIR = path.resolve(import.meta.dirname, '..', '..', 'views');
// logo výrobce v patičce (Volt) — vykreslí se, jen když soubor existuje (public/img/volt-logo.svg nebo .png)
const LOGO_VYROBCE = ['volt-logo.svg', 'volt-logo.png'].find((f) =>
  existsSync(path.resolve(import.meta.dirname, '..', '..', 'public', 'img', f)),
);

export function formatujDatum(d: Date | string | null | undefined, sCasem = true): string {
  if (!d) return '';
  const dt = typeof d === 'string' ? new Date(d) : d;
  const datum = dt.toLocaleDateString('cs-CZ', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone: 'Europe/Prague',
  });
  if (!sCasem) return datum;
  const cas = dt.toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Prague',
  });
  return `${datum} ${cas}`;
}

// verze statických souborů do URL (?v=…) — po nasazení nové verze prohlížeč nepoužije starý styl z keše
const VERZE_STATIKY = Date.now().toString(36);

export default fp(async function sablony(app: FastifyInstance) {
  const eta = new Eta({
    views: VIEWS_DIR,
    cache: app.env.NODE_ENV === 'production',
    autoEscape: true,
    useWith: false,
  });

  /**
   * Vykreslí šablonu v layoutu se společnými daty (t, obec, uzivatel, csrf, menu, vzhled…) a vrátí HTML.
   * Jediné místo, kde se skládají data layoutu — používá ho reply.view i shell hlavičky pro aplikace
   * (`/api/interni/hlavicka`, src/moduly/sluzby/hlavicka.ts). `volby.flash`: vypsat hlášku ze sezení (reply.view ji
   * pak spotřebuje; shell ji nechává na stránku webu).
   */
  app.decorate(
    'vykresli',
    async function (
      req: FastifyRequest,
      reply: FastifyReply,
      sablona: string,
      data: Record<string, unknown> = {},
      volby: { flash?: boolean } = {},
    ): Promise<string> {
      // CSRF token se vytvoří až ve chvíli, kdy ho šablona opravdu vypíše (formulář s polem _csrf). Vytvoření tokenu
      // zakládá sezení (cookie mo_sezeni) — anonymní návštěvník stránky bez formuláře tak žádnou cookie nedostane.
      // Objekt s toString(): Eta při vypsání volá String(), layout si data kopíruje (spread) bez vyvolání.
      let token: string | null = null;
      const csrf = {
        toString: () => (token ??= req.session ? reply.generateCsrf() : ''),
      };
      const layout: Record<string, unknown> = {};
      for (const f of app.dataLayoutu) Object.assign(layout, await f(req).catch(() => ({})));
      // vypnuté moduly obce (Správa → Moduly obce): šablony vidí `obec.moduly` podle skutečného stavu a menu webu
      // nemá odkazy na jejich stránky; `obecStaticka` = profil z obec.yml (co je v instalaci registrované)
      let obec = app.obec;
      if (app.hasDecorator('moduly')) {
        obec = await app.moduly.obecProSablony().catch(() => app.obec);
        if (Array.isArray(layout.menu)) {
          const skryte = await app.moduly.skryteCesty().catch(() => [] as string[]);
          if (skryte.length)
            layout.menu = filtrujMenu(
              layout.menu as PolozkaMenu[],
              skryte,
              app.env.BASE_URL.replace(/\/$/, ''),
            );
        }
      }
      // název infokanálu navenek (Správa → Vzhled, i v náhledu vzhledu) — šablony ho berou z obec.texty
      const vzhledLayoutu = layout.vzhled as { nazevInfokanalu?: string } | undefined;
      obec = {
        ...obec,
        texty: { ...obec.texty, nazev_infokanalu: vzhledLayoutu?.nazevInfokanalu || nazevInfokanalu(app) },
      };
      return eta.renderAsync(sablona, {
        t: app.t,
        obec,
        obecStaticka: app.obec,
        devlog: app.env.DEVLOG,
        logoVyrobce: LOGO_VYROBCE ? `/static/img/${LOGO_VYROBCE}` : null,
        env: app.env.NODE_ENV,
        uzivatel: req.uzivatel ?? null,
        // odkaz EDIT u titulků stránek a příspěvků (role web; admin a správce ji mají v sobě)
        muzeEditovatWeb: maRoli(req.uzivatel, 'web'),
        csrf,
        cesta: req.url.split('?')[0],
        cestaSDotazem: req.url.slice(0, 300),
        flash: volby.flash === false ? null : (req.session?.flash ?? null),
        fmtDatum: formatujDatum,
        fmtTelefon: formatujTelefon,
        fmtTelefonSkryty: maskujTelefon,
        v: VERZE_STATIKY,
        ...layout,
        ...data,
      });
    },
  );

  app.decorateReply(
    'view',
    async function (this: FastifyReply, sablona: string, data: Record<string, unknown> = {}) {
      const req = this.request;
      const html = await app.vykresli(req, this, sablona, data);
      if (req.session?.flash) delete req.session.flash;
      if (!this.statusCode || this.statusCode === 200) this.code((data.status as number | undefined) ?? 200);
      return this.type('text/html; charset=utf-8').send(html);
    },
  );
});

declare module 'fastify' {
  interface FastifyInstance {
    /** vykreslí šablonu v layoutu se společnými daty a vrátí HTML (reply.view ho odešle) */
    vykresli(
      req: FastifyRequest,
      reply: FastifyReply,
      sablona: string,
      data?: Record<string, unknown>,
      volby?: { flash?: boolean },
    ): Promise<string>;
  }
  interface FastifyReply {
    view(sablona: string, data?: Record<string, unknown>): Promise<FastifyReply>;
  }
}
