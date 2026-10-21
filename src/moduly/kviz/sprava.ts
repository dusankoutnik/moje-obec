// Správa kvízu (role kviz nebo web, admin vše): přehled kategorií a otázek s úspěšností hráčů,
// vypnutí/zapnutí otázky, nové načtení balíků. Otázky z balíků se upravují v YAML, ne tady.
// Jen správce obce (spravce, admin): statistiky hráčů a ručně přidané otázky (přidat, upravit, stáhnout jako YAML).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { maRoli } from '../ucty/sluzba.js';
import { zapisAudit } from '../../lib/audit.js';
import type { KvizSluzba } from './sluzba.js';
import type { VysledekImportu } from './import.js';
import {
  exportYaml,
  formularZ,
  NOVA_KATEGORIE,
  overFormular,
  pridejOtazku,
  rucniOtazka,
  upravOtazku,
  type FormularOtazky,
} from './rucne.js';
import {
  MIN_ODPOVEDI_OBLAST,
  NA_STRANKU,
  nactiRazeni,
  RAZENI,
  seznamHracu,
  souhrnHracu,
  VYCHOZI_SMER,
} from './statistiky.js';

export default async function kvizSprava(app: FastifyInstance, z: { sluzba: KvizSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const pravo = vyzadujRoli('kviz', 'web');
  // statistiky hráčů a ruční otázky: jen správce obce (admin má vše) — ne role kviz ani web
  const pravoSpravce = vyzadujRoli('spravce');
  const jeSpravce = (req: FastifyRequest) => maRoli(req.uzivatel, 'spravce');

  app.get('/sprava/kviz', { preHandler: pravo }, async (req, reply) => {
    const prehled = await sluzba.prehledSpravy();
    const imp = await app.db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', 'kviz_import')
      .executeTakeFirst();
    return reply.view('kviz/sprava/index', {
      titulek: t('kviz.sprava_titulek'),
      ...prehled,
      posledniImport: (imp?.hodnota ?? null) as (VysledekImportu & { at: string }) | null,
      jeSpravce: jeSpravce(req),
    });
  });

  // ---------- statistiky hráčů (jen správce) ----------

  app.get<{ Querystring: { radit?: string; smer?: string; strana?: string } }>(
    '/sprava/kviz/hraci',
    { preHandler: pravoSpravce },
    async (req, reply) => {
      const { radit, smer } = nactiRazeni(req.query.radit, req.query.smer);
      const souhrn = await souhrnHracu(app.db);
      const stran = Math.max(1, Math.ceil(souhrn.vsichni / NA_STRANKU));
      const strana = Math.min(stran, Math.max(1, Math.floor(Number(req.query.strana)) || 1));
      return reply.view('kviz/sprava/hraci', {
        titulek: t('kviz.hraci_titulek'),
        souhrn,
        hraci: await seznamHracu(app.db, { radit, smer, strana }),
        radit,
        smer,
        strana,
        stran,
        sloupce: RAZENI,
        vychoziSmer: VYCHOZI_SMER,
        minOblast: MIN_ODPOVEDI_OBLAST,
      });
    },
  );

  // ---------- ruční otázky (jen správce) ----------

  async function formular(f: FormularOtazky, extra: { id?: string; chyby?: string[] } = {}) {
    const kategorie = await app.db
      .selectFrom('kviz_kategorie')
      .select(['slug', 'nazev', 'ikona'])
      .orderBy('poradi')
      .orderBy('nazev')
      .execute();
    return {
      titulek: extra.id ? t('kviz.rucni_upravit', { id: extra.id }) : t('kviz.rucni_nova'),
      kategorie,
      f: { obtiznost: '3', ...f },
      id: extra.id ?? null,
      chyby: extra.chyby ?? [],
      nova: NOVA_KATEGORIE,
    };
  }

  app.get<{ Querystring: { kategorie?: string } }>(
    '/sprava/kviz/nova',
    { preHandler: pravoSpravce },
    async (req, reply) =>
      reply.view('kviz/sprava/otazka', await formular({ kategorie: req.query.kategorie })),
  );

  app.post<{ Body: FormularOtazky }>(
    '/sprava/kviz/nova',
    { preHandler: pravoSpravce },
    async (req, reply) => {
      const f = req.body ?? {};
      const v = await overFormular(app.db, f);
      if (!v.ok) return reply.code(400).view('kviz/sprava/otazka', await formular(f, { chyby: v.chyby }));
      const id = await pridejOtazku(app.db, v, req.uzivatel!, req.ip);
      const slug = 'slug' in v.kategorie ? v.kategorie.slug : v.kategorie.nova.kategorie;
      req.session.flash = { typ: 'ok', text: t('kviz.rucni_pridana', { id }) };
      return reply.redirect(`/sprava/kviz/${slug}#o-${encodeURIComponent(id)}`, 303);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/kviz/otazka/:id/upravit',
    { preHandler: pravoSpravce },
    async (req, reply) => {
      const o = await rucniOtazka(app.db, req.params.id);
      if (!o) return reply.callNotFound();
      return reply.view('kviz/sprava/otazka', await formular(formularZ(o), { id: o.id }));
    },
  );

  app.post<{ Params: { id: string }; Body: FormularOtazky }>(
    '/sprava/kviz/otazka/:id/upravit',
    { preHandler: pravoSpravce },
    async (req, reply) => {
      if (!(await rucniOtazka(app.db, req.params.id))) return reply.callNotFound();
      const f = req.body ?? {};
      const v = await overFormular(app.db, f);
      if (!v.ok)
        return reply
          .code(400)
          .view('kviz/sprava/otazka', await formular(f, { id: req.params.id, chyby: v.chyby }));
      const slug = await upravOtazku(app.db, req.params.id, v, req.uzivatel!, req.ip);
      if (!slug) return reply.callNotFound();
      req.session.flash = { typ: 'ok', text: t('kviz.rucni_upravena', { id: req.params.id }) };
      return reply.redirect(`/sprava/kviz/${slug}#o-${encodeURIComponent(req.params.id)}`, 303);
    },
  );

  app.get<{ Params: { slug: string } }>(
    '/sprava/kviz/:slug/rucne.yml',
    { preHandler: pravoSpravce },
    async (req, reply) => {
      const yaml = await exportYaml(app.db, req.params.slug);
      if (!yaml) return reply.callNotFound();
      return reply
        .type('application/yaml; charset=utf-8')
        .header('content-disposition', `attachment; filename="${req.params.slug}-rucne.yml"`)
        .send(yaml);
    },
  );

  app.post('/sprava/kviz/import', { preHandler: pravo }, async (req, reply) => {
    const v = await app.kvizImport();
    await zapisAudit(app.db, {
      uzivatelId: req.uzivatel!.id,
      akce: 'kviz.import',
      detail: {
        otazky: v.otazky,
        nove: v.nove,
        zmenene: v.zmenene,
        deaktivovane: v.deaktivovane,
        chyby: v.chyby.length,
        kolize: v.kolize.length,
      },
      ip: req.ip,
    });
    req.session.flash = v.chyby.length
      ? { typ: 'chyba', text: t('kviz.import_chyby', { n: v.chyby.length }) }
      : { typ: 'ok', text: t('kviz.import_hotovo', { n: v.otazky, nove: v.nove, zmenene: v.zmenene }) };
    return reply.redirect('/sprava/kviz', 303);
  });

  app.get<{ Params: { slug: string } }>('/sprava/kviz/:slug', { preHandler: pravo }, async (req, reply) => {
    const d = await sluzba.otazkySpravy(req.params.slug);
    if (!d) return reply.callNotFound();
    return reply.view('kviz/sprava/kategorie', {
      titulek: d.kategorie.nazev,
      ...d,
      jeSpravce: jeSpravce(req),
      maRucne: d.otazky.some((o) => o.rucne && o.stav !== 'vypnuta'),
    });
  });

  app.post<{ Params: { id: string }; Body: { akce?: string } }>(
    '/sprava/kviz/otazka/:id',
    { preHandler: pravo },
    async (req, reply) => {
      const zapnout = req.body?.akce === 'zapnout';
      const slug = await sluzba.prepniOtazku(req.params.id, zapnout, req.uzivatel!, req.ip);
      if (!slug) return reply.callNotFound();
      req.session.flash = {
        typ: 'ok',
        text: t(zapnout ? 'kviz.otazka_zapnuta' : 'kviz.otazka_vypnuta', { id: req.params.id }),
      };
      return reply.redirect(`/sprava/kviz/${slug}#o-${encodeURIComponent(req.params.id)}`, 303);
    },
  );
}
