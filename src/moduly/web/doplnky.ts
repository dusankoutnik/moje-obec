// Text obce k nativním stránkám platformy (kontakt, GDPR, prohlášení o přístupnosti).
// Nativní stránka se skládá z profilu obce (obec.yml); co v profilu není (konkrétní znění zásad GDPR, fotka úřadu,
// vlastní prohlášení o přístupnosti…), napíše obec jako běžnou stránku webu s adresou „<nativní>-obec“ — tu adresu
// dostane sama, když redaktor založí stránku nejvyšší úrovně se stejným názvem (např. „Kontakt“ → kontakt-obec).
// Zveřejněný text se zobrazí na nativní stránce; samostatná adresa doplňku přesměruje (301) na nativní stránku.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';

/** nativní stránka → slug stránky webu s textem obce */
export const DOPLNKY: Record<string, string> = {
  '/kontakt': 'kontakt-obec',
  '/ochrana-osobnich-udaju': 'ochrana-osobnich-udaju-obec',
  '/prohlaseni-o-pristupnosti': 'prohlaseni-o-pristupnosti-obec',
};

export interface Doplnek {
  id: string;
  titulek: string;
  obsah_html: string;
}

/** zveřejněný text obce k nativní stránce (jen stránka nejvyšší úrovně, mimo koš), jinak null */
export async function nactiDoplnek(db: Db, cesta: string): Promise<Doplnek | null> {
  const slug = DOPLNKY[cesta];
  if (!slug) return null;
  const r = await db
    .selectFrom('web_obsah')
    .select(['id', 'titulek', 'obsah_html'])
    .where('typ', '=', 'stranka')
    .where('slug', '=', slug)
    .where('nadrazena_id', 'is', null)
    .where('stav', '=', 'zverejneno')
    .where('smazano_at', 'is', null)
    .executeTakeFirst();
  return r && r.obsah_html.trim() ? r : null;
}

/** samostatné adresy doplňků → nativní stránka (doplněk se čte jen jako součást nativní stránky) */
export async function presmerovaniDoplnku(app: FastifyInstance) {
  for (const [cesta, slug] of Object.entries(DOPLNKY))
    app.get(`/${slug}`, async (_req, reply) => reply.redirect(cesta, 301));
}
