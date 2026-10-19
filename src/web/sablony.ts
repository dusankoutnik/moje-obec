// Šablony Eta: reply.view('soubor', data) vykreslí šablonu v layoutu se společnými daty (t, obec, uzivatel, csrf).
import path from 'node:path';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { formatujTelefon } from '../lib/kontakty.js';

export const VIEWS_DIR = path.resolve(import.meta.dirname, '..', '..', 'views');

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

  app.decorateReply(
    'view',
    async function (this: FastifyReply, sablona: string, data: Record<string, unknown> = {}) {
      const req = this.request;
      // CSRF token se vytvoří až ve chvíli, kdy ho šablona opravdu vypíše (formulář s polem _csrf). Vytvoření tokenu
      // zakládá sezení (cookie mo_sezeni) — anonymní návštěvník stránky bez formuláře tak žádnou cookie nedostane.
      // Objekt s toString(): Eta při vypsání volá String(), layout si data kopíruje (spread) bez vyvolání.
      let token: string | null = null;
      const csrf = {
        toString: () => (token ??= req.session ? this.generateCsrf() : ''),
      };
      const layout: Record<string, unknown> = {};
      for (const f of app.dataLayoutu) Object.assign(layout, await f(req).catch(() => ({})));
      const html = await eta.renderAsync(sablona, {
        t: app.t,
        obec: app.obec,
        env: app.env.NODE_ENV,
        uzivatel: req.uzivatel ?? null,
        csrf,
        cesta: req.url.split('?')[0],
        cestaSDotazem: req.url.slice(0, 300),
        flash: req.session?.flash ?? null,
        fmtDatum: formatujDatum,
        fmtTelefon: formatujTelefon,
        v: VERZE_STATIKY,
        ...layout,
        ...data,
      });
      if (req.session?.flash) delete req.session.flash;
      if (!this.statusCode || this.statusCode === 200) this.code((data.status as number | undefined) ?? 200);
      return this.type('text/html; charset=utf-8').send(html);
    },
  );
});

declare module 'fastify' {
  interface FastifyReply {
    view(sablona: string, data?: Record<string, unknown>): Promise<FastifyReply>;
  }
}
