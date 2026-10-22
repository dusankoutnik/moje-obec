// Správa webu → „Akce ke zpracování“: koncepty akcí z rezervací, návrhy propojení, změny termínu a zrušené
// rezervace. Vše jsou formuláře (funguje bez JS), práva jako editace obsahu webu (role web), audit v službě.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { datumPraha } from '../../lib/datum.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import type { WebSluzby } from './index.js';

type Telo = Record<string, string | string[] | undefined>;
const jeden = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')).trim();
const REF = /^[res]\d{1,12}$/;

export const CESTA_ZPRACOVANI = '/sprava/web/akce/zpracovani';

export default async function webSpravaAkce(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;
  const redaktor = vyzadujRoli('web');

  app.get(CESTA_ZPRACOVANI, { preHandler: redaktor }, async (_req, reply) => {
    await s.propojeni.synchronizuj().catch((e) => app.log.warn({ err: e }, 'synchronizace akcí'));
    const [prehled, ignorovane] = await Promise.all([
      s.propojeni.prehled(),
      s.propojeni.seznamIgnorovanych(),
    ]);
    // možné cíle propojení konceptu: nepropojené akce od včerejška
    const cile = await app.db
      .selectFrom('web_obsah')
      .select(['id', 'titulek', 'datum', 'stav'])
      .where('typ', '=', 'akce')
      .where('rezervace_ref', 'is', null)
      .where('smazano_at', 'is', null)
      .where('datum', '>=', new Date(Date.now() - 86_400_000))
      .orderBy('datum')
      .limit(200)
      .execute();
    return reply.view('web/sprava/akce-zpracovani', {
      titulek: t('propojeni.titulek'),
      p: prehled,
      ignorovane,
      cile,
      konceptyZapnute: app.obec.web.akce_koncepty,
      datumPraha,
    });
  });

  const zpet = (req: FastifyRequest, typ: 'ok' | 'info' | 'chyba', klic: string) => {
    req.session.flash = { typ, text: t(klic) };
    return CESTA_ZPRACOVANI;
  };

  app.post<{ Body: Telo }>(`${CESTA_ZPRACOVANI}/propojit`, { preHandler: redaktor }, async (req, reply) => {
    const ref = jeden(req.body?.ref);
    const akceId = jeden(req.body?.akce_id);
    if (!REF.test(ref) || !akceId) return reply.redirect(zpet(req, 'chyba', 'propojeni.vyberte_akci'));
    const v = await s.propojeni.propoj(akceId, ref, req.uzivatel!.id, req.ip);
    return reply.redirect(
      zpet(
        req,
        v === 'ok' ? 'ok' : 'chyba',
        v === 'ok' ? 'propojeni.propojeno' : v === 'obsazeno' ? 'propojeni.obsazeno' : 'propojeni.nenalezeno',
      ),
    );
  });

  app.post<{ Body: Telo }>(`${CESTA_ZPRACOVANI}/ignorovat`, { preHandler: redaktor }, async (req, reply) => {
    const ref = jeden(req.body?.ref);
    if (REF.test(ref)) await s.propojeni.ignoruj(ref, req.uzivatel!.id, req.ip);
    return reply.redirect(zpet(req, 'info', 'propojeni.ignorovano'));
  });

  app.post<{ Body: Telo }>(
    `${CESTA_ZPRACOVANI}/zrusit-ignorovani`,
    { preHandler: redaktor },
    async (req, reply) => {
      const ref = jeden(req.body?.ref);
      if (REF.test(ref)) await s.propojeni.zrusIgnorovani(ref, req.uzivatel!.id, req.ip);
      return reply.redirect(zpet(req, 'info', 'propojeni.ignorovani_zruseno'));
    },
  );

  // ruční založení konceptu (návrh propojení odmítnut nebo automatické koncepty vypnuté) → rovnou do editoru
  app.post<{ Body: Telo }>(`${CESTA_ZPRACOVANI}/koncept`, { preHandler: redaktor }, async (req, reply) => {
    const ref = jeden(req.body?.ref);
    const e = REF.test(ref) ? await s.propojeni.termin(ref) : undefined;
    if (!e) return reply.redirect(zpet(req, 'chyba', 'propojeni.nenalezeno'));
    await s.propojeni.zrusIgnorovani(ref, req.uzivatel!.id, req.ip);
    const id = await s.propojeni.zalozKoncept(e, req.uzivatel!.id, req.ip);
    if (!id) return reply.redirect(zpet(req, 'chyba', 'propojeni.obsazeno'));
    req.session.flash = { typ: 'info', text: t('propojeni.koncept_zalozen') };
    return reply.redirect(`/sprava/web/obsah/${id}`);
  });

  app.post<{ Body: Telo }>(`${CESTA_ZPRACOVANI}/termin`, { preHandler: redaktor }, async (req, reply) => {
    const akceId = jeden(req.body?.akce_id);
    const prevzit = jeden(req.body?.volba) === 'prevzit';
    const ok = prevzit
      ? await s.propojeni.prevezmiTermin(akceId, req.uzivatel!.id, req.ip)
      : await s.propojeni.ponechTermin(akceId, req.uzivatel!.id, req.ip);
    return reply.redirect(
      zpet(
        req,
        ok ? 'ok' : 'chyba',
        ok ? (prevzit ? 'propojeni.termin_prevzat' : 'propojeni.termin_ponechan') : 'propojeni.nenalezeno',
      ),
    );
  });

  app.post<{ Body: Telo }>(`${CESTA_ZPRACOVANI}/odpojit`, { preHandler: redaktor }, async (req, reply) => {
    await s.propojeni.odpoj(jeden(req.body?.akce_id), req.uzivatel!.id, req.ip);
    return reply.redirect(zpet(req, 'info', 'propojeni.odpojeno'));
  });
}
