// Veřejná část úřední desky: aktuální dokumenty, archiv sejmutých, detail, RSS, rozpočet, povinné informace.
import type { FastifyInstance } from 'fastify';
import { escapujHtml } from '../../lib/html.js';
import { lidskaVelikost, popisTypu } from '../../lib/soubory.js';
import { cisloStrany } from '../../lib/vstupy.js';
import { urlSouboru } from '../../web/soubory.js';
import { TYPY_ROZPOCTU, type DeskaSluzba } from './sluzba.js';
import { sbirkaPp, vyplnPi } from './povinne.js';

export default async function deskaRoutes(app: FastifyInstance, z: { sluzba: DeskaSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const pomocnici = { lidskaVelikost, popisTypu, urlSouboru };

  app.get<{ Querystring: { kategorie?: string; q?: string } }>('/uredni-deska', async (req, reply) => {
    const kategorie = await sluzba.kategorie();
    const f = { kategorie: String(req.query.kategorie ?? ''), q: String(req.query.q ?? '').slice(0, 100) };
    const dokumenty = await sluzba.aktualni(f);
    return reply.view('deska/index', {
      titulek: t('deska.titulek'),
      kategorie,
      dokumenty,
      f,
      rss: '/uredni-deska/rss.xml',
      sbirkaPp: sbirkaPp(app.obec),
      ...pomocnici,
    });
  });

  app.get<{ Querystring: { kategorie?: string; q?: string; rok?: string; strana?: string } }>(
    '/uredni-deska/archiv',
    async (req, reply) => {
      const kategorie = await sluzba.kategorie(false);
      const f = {
        kategorie: String(req.query.kategorie ?? ''),
        q: String(req.query.q ?? '').slice(0, 100),
        rok: /^\d{4}$/.test(String(req.query.rok ?? '')) ? Number(req.query.rok) : undefined,
        stranka: cisloStrany(req.query.strana),
      };
      const vysledek = await sluzba.archiv(f);
      const roky = await sluzba.rokyArchivu();
      return reply.view('deska/archiv', { titulek: t('deska.archiv'), kategorie, f, roky, ...vysledek });
    },
  );

  app.get('/uredni-deska/rss.xml', async (_req, reply) => {
    const dokumenty = await sluzba.aktualni();
    const base = app.env.BASE_URL;
    const x = escapujHtml;
    const polozky = dokumenty
      .map(
        (d) =>
          `<item><title>${x(d.nazev)}</title><link>${base}/uredni-deska/${d.id}</link><guid isPermaLink="false">${d.id}</guid><pubDate>${d.vyveseno_od.toUTCString()}</pubDate><category>${x(d.kategorie)}</category><description>${x(d.popis || d.kategorie)}</description></item>`,
      )
      .join('\n');
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>${x(t('deska.titulek'))} — ${x(app.obec.obec.nazev)}</title><link>${base}/uredni-deska</link><description>${x(t('deska.rss_popis', { obec: app.obec.obec.nazev }))}</description><language>cs</language>
${polozky}
</channel></rss>`;
    return reply.type('application/rss+xml; charset=utf-8').send(xml);
  });

  app.get<{ Params: { id: string } }>('/uredni-deska/:id', async (req, reply) => {
    const d = await sluzba.detail(req.params.id);
    const ted = new Date();
    // připravené (budoucí) a smazané dokumenty veřejně nejsou
    if (!d || d.smazano_at || d.vyveseno_od > ted) return reply.callNotFound();
    const sejmuto = !!d.sejmuto_do && d.sejmuto_do <= ted;
    // dokumenty jiných úřadů (exekuce, dražby…) se po sejmutí veřejně nezobrazují — jen informace, že visel
    if (sejmuto && !d.archiv_verejny)
      return reply.code(410).view('chyba', {
        status: 410,
        nadpis: t('deska.sejmuto_neverejne'),
        text: t('deska.sejmuto_neverejne_text'),
      });
    return reply.view('deska/detail', { titulek: d.nazev, d, sejmuto, ...pomocnici });
  });

  app.get('/rozpocet', async (_req, reply) => {
    const { platne, archiv } = await sluzba.rozpocet();
    return reply.view('deska/rozpocet', {
      titulek: t('deska.rozpocet_titulek'),
      platne,
      archiv,
      typy: TYPY_ROZPOCTU,
    });
  });

  app.get('/povinne-informace', async (_req, reply) => {
    const vlastni = new Map(
      (await app.db.selectFrom('pi_body').select(['klic', 'obsah_html']).execute()).map((r) => [
        r.klic,
        r.obsah_html,
      ]),
    );
    const body = vyplnPi(app.obec, vlastni, { baseUrl: app.env.BASE_URL, deska: true });
    return reply.view('deska/povinne', { titulek: t('pi.titulek'), body });
  });
}
