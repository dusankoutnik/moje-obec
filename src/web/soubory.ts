// Výdej nahraných souborů: /soubory/<id>/<název>. Typ z DB (zjištěný z obsahu), nosniff, u dokumentů
// Content-Disposition (PDF, video a titulky inline, ostatní ke stažení), obrázky s variantou ?v=nahled.
// HTTP Range (206) kvůli videu: posouvání v přehrávači a iOS Safari, který bez Range video vůbec nepřehraje.
import { createReadStream, promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { maRoli } from '../moduly/ucty/sluzba.js';

/**
 * Jeden rozsah z hlavičky Range (`bytes=a-b`, `bytes=a-`, `bytes=-n`). `null` = hlavičku ignorovat a poslat celý
 * soubor (jiný formát, víc rozsahů — RFC 9110 to dovoluje), `'mimo'` = rozsah za koncem souboru (416).
 */
export function rozsah(hlavicka: string, velikost: number): { start: number; konec: number } | 'mimo' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(hlavicka.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (velikost === 0) return 'mimo';
  let start: number;
  let konec: number;
  if (!m[1]) {
    // posledních n bajtů
    const n = Number(m[2]);
    if (!n) return 'mimo';
    start = Math.max(0, velikost - n);
    konec = velikost - 1;
  } else {
    start = Number(m[1]);
    konec = m[2] ? Math.min(Number(m[2]), velikost - 1) : velikost - 1;
  }
  if (!Number.isSafeInteger(start)) return null;
  if (start >= velikost) return 'mimo';
  if (konec < start) return null;
  return { start, konec };
}

export default async function souboryRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string; nazev?: string }; Querystring: { v?: string } }>(
    '/soubory/:id/:nazev?',
    async (req, reply) => {
      const s = await app.soubory.podleId(req.params.id);
      if (!s) return reply.callNotFound();
      // příloha dokumentu desky, který veřejnost nevidí (sejmutý dokument jiného úřadu, koš) — jen pro úřad
      if (
        app.obec.moduly.deska &&
        s.druh === 'dokument' &&
        !maRoli(req.uzivatel, 'deska') &&
        (await app.deska.souborNeverejny(s.id))
      )
        return reply.callNotFound();
      const nahled = req.query.v === 'nahled' && s.mime.startsWith('image/') && s.druh !== 'logo';
      let cesta = app.soubory.cesta(s.id, nahled ? 'nahled' : '');
      let mime = nahled ? 'image/webp' : s.mime;
      try {
        await fs.access(cesta);
      } catch {
        if (!nahled) return reply.callNotFound();
        cesta = app.soubory.cesta(s.id);
        mime = s.mime;
      }
      const st = await fs.stat(cesta);
      reply
        .header('content-type', mime === 'text/vtt' ? 'text/vtt; charset=utf-8' : mime)
        .header('accept-ranges', 'bytes')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=31536000, immutable');
      if (!s.mime.startsWith('image/')) {
        const nazev = s.puvodni_nazev;
        const ascii =
          nazev
            .normalize('NFD')
            .replace(/[^\x20-\x7e]/g, '')
            .replace(/["\\]/g, '') || 'soubor';
        const inline = s.mime === 'application/pdf' || s.mime.startsWith('video/') || s.mime === 'text/vtt';
        reply.header(
          'content-disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nazev)}`,
        );
        if (s.mime !== 'application/pdf')
          reply.header('content-security-policy', "default-src 'none'; sandbox");
      }
      const range = req.headers.range;
      if (typeof range === 'string' && range) {
        const r = rozsah(range, st.size);
        if (r === 'mimo') return reply.code(416).header('content-range', `bytes */${st.size}`).send();
        if (r)
          return reply
            .code(206)
            .header('content-range', `bytes ${r.start}-${r.konec}/${st.size}`)
            .header('content-length', r.konec - r.start + 1)
            .send(createReadStream(cesta, { start: r.start, end: r.konec }));
      }
      reply.header('content-length', st.size);
      return reply.send(createReadStream(cesta));
    },
  );
}

export function urlSouboru(s: { id: string; puvodni_nazev: string }, nahled = false): string {
  return `/soubory/${s.id}/${encodeURIComponent(s.puvodni_nazev)}${nahled ? '?v=nahled' : ''}`;
}
