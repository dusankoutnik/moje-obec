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

/**
 * Hlavičky pro každou odpověď. Odpovědi, které Fastify neodesílá sám (hijack — OIDC provider), je musí nastavit
 * ručně přes tuto funkci, háček onSend se na ně nevztahuje.
 */
export function zakladniHlavicky(env: { BASE_URL: string; ROBOTS_NOINDEX: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN',
  };
  // HSTS jen u instalace na https (za proxy je BASE_URL https, i když aplikace sama poslouchá na http)
  if (env.BASE_URL.startsWith('https://')) h['strict-transport-security'] = 'max-age=31536000';
  if (env.ROBOTS_NOINDEX) h['x-robots-tag'] = 'noindex, nofollow';
  return h;
}

/** CSP pro stránky OIDC provideru: jeho stránky (form_post, odhlášení) mají vložený skript, proto bez script-src */
export const CSP_OIDC = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

export default fp(async function hlavicky(app: FastifyInstance) {
  const zaklad = zakladniHlavicky(app.env);
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(zaklad)) reply.header(k, v);
    // CSP jen pro stránky; soubory (/soubory) si nastavují vlastní přísnější (sandbox), PDF ji nepotřebuje
    const typ = String(reply.getHeader('content-type') ?? '');
    if (typ.startsWith('text/html') && !reply.hasHeader('content-security-policy'))
      reply.header('content-security-policy', CSP);
    return payload;
  });
});
