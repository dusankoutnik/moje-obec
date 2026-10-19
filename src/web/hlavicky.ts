// Bezpečnostní hlavičky přímo z aplikace (ne jen z reverzní proxy) — platí stejně za Caddy, NPM i bez proxy.
// CSP: vše z vlastního původu; styly i inline (šablona vkládá <style> s barvami schématu a písmy, editor Quill a
// náhled vzhledu používají atribut style); obrázky i data:/blob: (editor zmenšuje fotky v prohlížeči); přehrávače
// YouTube (youtube-nocookie) a Vimeo se vkládají až po kliknutí (public/js/web.js). Žádné inline skripty.
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

export default fp(async function hlavicky(app: FastifyInstance) {
  const https = app.env.BASE_URL.startsWith('https://');
  const noindex = app.env.ROBOTS_NOINDEX;
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
    // HSTS jen u instalace na https (za proxy je BASE_URL https, i když aplikace sama poslouchá na http)
    if (https) reply.header('strict-transport-security', 'max-age=31536000');
    if (noindex) reply.header('x-robots-tag', 'noindex, nofollow');
    // CSP jen pro stránky; soubory (/soubory) si nastavují vlastní přísnější (sandbox), PDF ji nepotřebuje
    const typ = String(reply.getHeader('content-type') ?? '');
    if (typ.startsWith('text/html') && !reply.hasHeader('content-security-policy'))
      reply.header('content-security-policy', CSP);
    return payload;
  });
});
