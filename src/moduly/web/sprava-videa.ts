// Správa videí webu (role web): vlastní soubor MP4/WebM s plakátem a titulky, nebo odkaz na YouTube/Vimeo
// (náhled se stáhne k nám). Pořadí šipkami, „na titulce“, koncept/zveřejněno, koš (nic se nemaže natrvalo).
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebVideo } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { chybaSouboruText, lidskaVelikost, popisTypu, type ChybaSouboru } from '../../lib/soubory.js';
import { souboryZPole } from '../../web/nahravani.js';
import { urlSouboru } from '../../web/soubory.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import type { WebSluzby } from './index.js';
import { odkazNaSluzbu, parsujOdkazVidea, type DataVidea } from './videa.js';

type Telo = Record<string, string | string[] | undefined>;
const jeden = (v: unknown) =>
  (Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v)).trim();

class ChybaFormulare extends Error {}

export default async function webSpravaVidea(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;
  const redaktor = vyzadujRoli('web');
  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, odkazNaSluzbu };

  const chybaVidea = (c: ChybaSouboru) =>
    c === 'typ'
      ? t('videa.chyba_typ')
      : c === 'velikost'
        ? t('videa.chyba_velikost')
        : chybaSouboruText(t, c);

  /** společná pole formuláře */
  function data(b: Telo): DataVidea {
    return {
      nazev: jeden(b.nazev).slice(0, 200),
      popis: jeden(b.popis).slice(0, 500),
      prepis: jeden(b.prepis).replace(/\r\n?/g, '\n').slice(0, 20_000),
      na_titulce: jeden(b.na_titulce) === 'ano',
    };
  }

  /** nahraný plakát (obrázek) z pole formuláře; null = nic nenahráno */
  async function plakat(req: FastifyRequest, alt: string): Promise<string | null> {
    const f = souboryZPole(req, 'plakat')[0];
    if (!f) return null;
    if (f.oriznuto) throw new ChybaFormulare(`${f.nazev}: ${chybaSouboruText(t, 'velikost')}`);
    const v = await app.soubory.uloz({
      data: await fs.readFile(f.cesta),
      nazev: f.nazev,
      druh: 'obrazek',
      nahralId: req.uzivatel!.id,
      alt,
    });
    if ('chyba' in v) throw new ChybaFormulare(`${f.nazev}: ${chybaSouboruText(t, v.chyba)}`);
    if (!v.soubor.mime.startsWith('image/'))
      throw new ChybaFormulare(`${f.nazev}: ${chybaSouboruText(t, 'typ')}`);
    return v.soubor.id;
  }

  async function titulky(req: FastifyRequest): Promise<string | null> {
    const f = souboryZPole(req, 'titulky')[0];
    if (!f) return null;
    const v = f.oriznuto
      ? ({ chyba: 'velikost' } as const)
      : await app.soubory.uloz({
          data: await fs.readFile(f.cesta),
          nazev: f.nazev,
          druh: 'titulky',
          nahralId: req.uzivatel!.id,
        });
    if ('chyba' in v) throw new ChybaFormulare(t('videa.chyba_titulky'));
    return v.soubor.id;
  }

  async function video(req: FastifyRequest): Promise<string | null> {
    const f = souboryZPole(req, 'soubor')[0];
    if (!f) return null;
    if (f.oriznuto) throw new ChybaFormulare(t('videa.chyba_velikost'));
    const v = await app.soubory.ulozVideo({ cesta: f.cesta, nazev: f.nazev, nahralId: req.uzivatel!.id });
    if ('chyba' in v) throw new ChybaFormulare(chybaVidea(v.chyba));
    return v.soubor.id;
  }

  async function seznam(reply: FastifyReply, navic: Record<string, unknown> = {}) {
    const videa = await s.videa.seznam({ verejne: false });
    const plakaty = await s.videa.proZobrazeni(videa);
    return reply.view('web/sprava/videa', {
      titulek: t('videa.titulek'),
      videa: videa.map((v) => ({ ...v, plakat: plakaty.find((p) => p.id === v.id)?.plakat ?? null })),
      f: { zdroj: 'odkaz', na_titulce: true },
      ...pomocnici,
      ...navic,
    });
  }

  async function detail(reply: FastifyReply, v: WebVideo, navic: Record<string, unknown> = {}) {
    const [zobrazeni] = await s.videa.proZobrazeni([v]);
    const soubor = v.soubor_id ? await app.soubory.podleId(v.soubor_id) : undefined;
    const tit = v.titulky_id ? await app.soubory.podleId(v.titulky_id) : undefined;
    return reply.view('web/sprava/video', {
      titulek: v.nazev || t('videa.upravit'),
      v,
      z: zobrazeni ?? null,
      soubor,
      titulkySoubor: tit,
      f: { ...v, odkaz: v.zdroj === 'soubor' ? '' : odkazNaSluzbu(v.zdroj, v.externi_id) },
      ...pomocnici,
      ...navic,
    });
  }

  app.get('/sprava/web/videa', { preHandler: redaktor }, async (_req, reply) => seznam(reply));

  // seznam pro editor textu (vložení videa do stránky)
  app.get('/sprava/web/videa.json', { preHandler: redaktor }, async (_req, reply) => {
    const videa = await s.videa.seznam({ verejne: false });
    return reply.header('cache-control', 'no-store').send(
      await Promise.all(
        videa.map(async (v) => ({
          id: v.id,
          nazev: v.nazev,
          zdroj: v.zdroj,
          stav: v.stav,
          odkaz: await s.videa.odkazZnacky(v),
        })),
      ),
    );
  });

  app.post<{ Body: Telo }>('/sprava/web/videa', { preHandler: redaktor }, async (req, reply) => {
    const b = req.body ?? {};
    const d = data(b);
    const zdroj = jeden(b.zdroj) === 'soubor' ? 'soubor' : 'odkaz';
    const odkaz = jeden(b.odkaz);
    const stav = jeden(b.akce) === 'zverejnit' ? 'zverejneno' : 'koncept';
    const aktor = req.uzivatel!.id;
    try {
      let id: string;
      let upozorneni: string | null = null;
      if (zdroj === 'odkaz') {
        const p = parsujOdkazVidea(odkaz);
        if (!p) throw new ChybaFormulare(t('videa.chyba_odkaz'));
        let plakatId = await plakat(req, d.nazev);
        let nazev = d.nazev;
        if (!plakatId) {
          const r = await s.videa.stahniNahled(p.zdroj, p.id, d.nazev, aktor);
          plakatId = r.plakat?.id ?? null;
          if (!plakatId) upozorneni = t('videa.nahled_nestazen');
          nazev ||= r.nazev ?? '';
        } else if (!nazev) nazev = (await s.videa.nazevZeSluzby(p.zdroj, p.id)) ?? '';
        if (!nazev) throw new ChybaFormulare(t('videa.chyba_nazev'));
        id = await s.videa.zaloz(
          {
            ...d,
            nazev,
            zdroj: p.zdroj,
            externi_id: p.id,
            plakat_id: plakatId,
            titulky_id: await titulky(req),
            stav,
          },
          aktor,
        );
      } else {
        if (!d.nazev) throw new ChybaFormulare(t('videa.chyba_nazev'));
        if (!souboryZPole(req, 'soubor').length) throw new ChybaFormulare(t('videa.chyba_soubor'));
        // nejdřív malé soubory (chyba v titulcích nezanechá v úložišti stovky MB), video nakonec
        const plakatId = await plakat(req, d.nazev);
        const titulkyId = await titulky(req);
        const souborId = await video(req);
        id = await s.videa.zaloz(
          { ...d, zdroj: 'soubor', soubor_id: souborId, plakat_id: plakatId, titulky_id: titulkyId, stav },
          aktor,
        );
      }
      const v = (await s.videa.podleId(id))!;
      req.session.flash = upozorneni
        ? { typ: 'info', text: `${t('videa.zalozeno', { nazev: v.nazev })} ${upozorneni}` }
        : stav === 'zverejneno'
          ? { typ: 'ok', text: t('videa.zverejneno'), odkaz: { url: '/videa', text: t('web.zobrazit') } }
          : { typ: 'ok', text: t('videa.zalozeno', { nazev: v.nazev }) };
      return reply.redirect(`/sprava/web/videa/${id}`);
    } catch (e) {
      if (!(e instanceof ChybaFormulare)) throw e;
      return seznam(reply.code(400), { f: { ...d, zdroj, odkaz }, chyba: e.message, otevrit: true });
    }
  });

  app.get<{ Params: { id: string } }>(
    '/sprava/web/videa/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const v = await s.videa.podleId(req.params.id);
      if (!v) return reply.callNotFound();
      return detail(reply, v);
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/videa/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const v = await s.videa.podleId(req.params.id);
      if (!v) return reply.callNotFound();
      const b = req.body ?? {};
      const akce = jeden(b.akce);
      const aktor = req.uzivatel!.id;
      if (akce === 'kos' || akce === 'obnovit') {
        await s.videa.doKose(v.id, akce === 'kos', aktor);
        req.session.flash = {
          typ: 'ok',
          text: akce === 'kos' ? t('web.v_kosi', { titulek: v.nazev }) : t('web.obnoveno'),
        };
        return reply.redirect(akce === 'kos' ? '/sprava/web/videa' : `/sprava/web/videa/${v.id}`);
      }
      if (akce === 'nahoru' || akce === 'dolu') {
        await s.videa.posun(v.id, akce);
        return reply.redirect(`/sprava/web/videa#v-${v.id}`);
      }
      const d = data(b);
      try {
        // textová pole jen ta, která formulář poslal (zatržítko „na titulce“ chybí = nezaškrtnuto)
        const zmena: Parameters<typeof s.videa.uprav>[1] = {
          nazev: d.nazev || v.nazev,
          na_titulce: d.na_titulce,
          ...(b.popis !== undefined ? { popis: d.popis } : {}),
          ...(b.prepis !== undefined ? { prepis: d.prepis } : {}),
        };
        if (v.zdroj === 'soubor') {
          const novy = await video(req);
          if (novy) zmena.soubor_id = novy;
        } else {
          const odkaz = jeden(b.odkaz);
          const p = odkaz ? parsujOdkazVidea(odkaz) : { zdroj: v.zdroj, id: v.externi_id };
          if (!p) throw new ChybaFormulare(t('videa.chyba_odkaz'));
          const jine = p.zdroj !== v.zdroj || p.id !== v.externi_id;
          zmena.zdroj = p.zdroj;
          zmena.externi_id = p.id;
          if ((jine || jeden(b.plakat_znovu) === 'ano') && !souboryZPole(req, 'plakat').length) {
            const r = await s.videa.stahniNahled(p.zdroj, p.id, zmena.nazev!, aktor);
            if (r.plakat) zmena.plakat_id = r.plakat.id;
            else req.session.flash = { typ: 'info', text: t('videa.nahled_nestazen') };
          }
        }
        const novyPlakat = await plakat(req, zmena.nazev!);
        if (novyPlakat) zmena.plakat_id = novyPlakat;
        const noveTitulky = await titulky(req);
        if (noveTitulky) zmena.titulky_id = noveTitulky;
        else if (jeden(b.titulky_odebrat) === 'ano') zmena.titulky_id = null;
        await s.videa.uprav(v.id, zmena);
        await zapisAudit(app.db, {
          uzivatelId: aktor,
          akce: 'web.video_uprava',
          detail: { id: v.id, nazev: zmena.nazev },
          ip: req.ip,
        });
      } catch (e) {
        if (!(e instanceof ChybaFormulare)) throw e;
        return detail(reply.code(400), v, { f: { ...v, ...d, odkaz: jeden(b.odkaz) }, chyba: e.message });
      }
      if (akce === 'zverejnit' || akce === 'skryt') {
        await s.videa.nastavStav(v.id, akce === 'zverejnit' ? 'zverejneno' : 'koncept', aktor);
        req.session.flash = {
          typ: 'ok',
          text: akce === 'zverejnit' ? t('videa.zverejneno') : t('app.ulozeno'),
          ...(akce === 'zverejnit' ? { odkaz: { url: '/videa', text: t('web.zobrazit') } } : {}),
        };
      } else if (!req.session.flash) req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      return reply.redirect(`/sprava/web/videa/${v.id}`);
    },
  );
}
