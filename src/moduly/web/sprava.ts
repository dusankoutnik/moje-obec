// Správa obsahu webu (redaktor): stránky a menu, aktuality, akce. Editor s konceptem, náhledem, automatickým
// ukládáním, revizemi a košem. Všechno funguje i bez JavaScriptu; JS přidává editor Quill a automatické ukládání.
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { casPraha, datumPraha } from '../../lib/datum.js';
import { obrazkyBezAlt, pocetBezPopisu, sanitizuj, textZHtml, zkrat } from '../../lib/html.js';
import { chybaSouboruText, lidskaVelikost, popisTypu } from '../../lib/soubory.js';
import { souboryZPole } from '../../web/nahravani.js';
import { urlSouboru } from '../../web/soubory.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { maRoli } from '../ucty/sluzba.js';
import type { WebSluzby } from './index.js';
import { rozdelPodleVidei } from './videa.js';
import { PRAZDNA_POLE, poleProEditor, TYPY, type PoleObsahu } from './obsah.js';

type Telo = Record<string, string | string[] | undefined>;
const jeden = (v: unknown) =>
  (Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v)).trim();

// cesta v administraci ↔ typ obsahu
export const SEKCE: Record<string, TypObsahu> = { aktuality: 'aktualita', akce: 'akce', stranky: 'stranka' };
export const SEKCE_TYPU: Record<TypObsahu, string> = {
  aktualita: 'aktuality',
  akce: 'akce',
  stranka: 'stranky',
  odkaz: 'stranky',
};

export default async function webSprava(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;
  const redaktor = vyzadujRoli('web');
  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, zkrat, textZHtml, datumPraha };

  app.get('/sprava/web', { preHandler: redaktor }, async (req, reply) => {
    const [koncepty, koncici, pocetPresmerovani, sObrazky] = await Promise.all([
      app.db
        .selectFrom('web_obsah')
        .select(['id', 'typ', 'titulek', 'upraveno_at', 'koncept_at', 'stav'])
        .where('smazano_at', 'is', null)
        .where((eb) => eb.or([eb('stav', '=', 'koncept'), eb('koncept', 'is not', null)]))
        .where('typ', '!=', 'odkaz')
        .orderBy('upraveno_at', 'desc')
        .limit(10)
        .execute(),
      s.dotace.koncici(30),
      s.presmerovani.pocet(),
      // obsah s obrázky bez popisu (import nevymýšlí alternativní texty — doplní je redaktor)
      app.db
        .selectFrom('web_obsah')
        .select(['id', 'typ', 'titulek', 'obsah_html'])
        .where('smazano_at', 'is', null)
        .where(sql<boolean>`obsah_html ~ '<img[^>]*alt=""'`)
        .orderBy('typ')
        .orderBy('titulek')
        .limit(500)
        .execute(),
    ]);
    const bezPopisu = sObrazky
      .map((o) => ({ id: o.id, typ: o.typ, titulek: o.titulek, n: pocetBezPopisu(o.obsah_html) }))
      .filter((o) => o.n > 0);
    return reply.view('web/sprava/index', {
      titulek: t('web.sprava_titulek'),
      bezPopisu,
      bezPopisuCelkem: bezPopisu.reduce((a, o) => a + o.n, 0),
      koncepty,
      koncici,
      pocetPresmerovani,
      jeSpravce: maRoli(req.uzivatel, 'spravce'),
    });
  });

  // --- seznamy ---
  app.get('/sprava/web/stranky', { preHandler: redaktor }, async (_req, reply) => {
    const strom = await s.obsah.strom();
    return reply.view('web/sprava/stranky', { titulek: t('web.stranky'), strom });
  });

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/stranky/:id/posun',
    { preHandler: redaktor },
    async (req, reply) => {
      await s.obsah.posun(
        req.params.id,
        jeden(req.body?.smer) === 'nahoru' ? 'nahoru' : 'dolu',
        req.uzivatel!.id,
      );
      return reply.redirect(`/sprava/web/stranky#p-${req.params.id}`);
    },
  );

  for (const [sekce, typ] of Object.entries(SEKCE)) {
    if (typ === 'stranka') continue;
    app.get<{ Querystring: { q?: string } }>(
      `/sprava/web/${sekce}`,
      { preHandler: redaktor },
      async (req, reply) => {
        const polozky = await s.obsah.proSpravu(typ, String(req.query.q ?? ''));
        // akce sálu a hřišť z rezervačního systému — jen pro přehled, upravují se tam
        const externi = typ === 'akce' ? await s.kalendar.akce() : [];
        return reply.view('web/sprava/seznam', {
          titulek: t(`web.${sekce}`),
          sekce,
          typ,
          polozky,
          externi,
          q: req.query.q ?? '',
        });
      },
    );
  }

  // --- editor ---
  async function editor(
    req: FastifyRequest,
    reply: FastifyReply,
    typ: TypObsahu,
    o: WebObsah | null,
    f: PoleObsahu,
    extra: Record<string, unknown> = {},
  ) {
    const [kategorie, nadrazene, obrazek] = await Promise.all([
      s.obsah.kategorie(),
      typ === 'stranka' || typ === 'odkaz' ? s.obsah.moznaNadrazena(o?.id ?? null) : Promise.resolve([]),
      f.obrazek_id ? app.soubory.podleId(f.obrazek_id) : Promise.resolve(undefined),
    ]);
    const maDeti = o ? await s.obsah.maDeti(o.id) : false;
    return reply.view('web/sprava/editor', {
      titulek: o ? t('web.upravit_' + typ) : t('web.novy_' + typ),
      typ,
      sekce: SEKCE_TYPU[typ],
      o,
      f,
      kategorie,
      nadrazene,
      maDeti,
      obrazek,
      verejnaUrl: o && o.stav === 'zverejneno' ? await s.obsah.url(o) : null,
      editor: true,
      ...pomocnici,
      ...extra,
    });
  }

  app.get<{ Querystring: { typ?: string; nadrazena?: string } }>(
    '/sprava/web/novy',
    { preHandler: redaktor },
    async (req, reply) => {
      const typ = (TYPY as string[]).includes(String(req.query.typ))
        ? (req.query.typ as TypObsahu)
        : 'aktualita';
      const f: PoleObsahu = { ...PRAZDNA_POLE, nadrazena_id: req.query.nadrazena || null };
      if (typ === 'aktualita') f.datum = new Date().toISOString();
      return editor(req, reply, typ, null, f);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const o = await s.obsah.podleId(req.params.id);
      if (!o) return reply.callNotFound();
      return editor(req, reply, o.typ, o, poleProEditor(o));
    },
  );

  /**
   * Přečte formulář editoru; obrázek z formuláře uloží (jen když `zapisovat` — náhled nic neukládá ani
   * nepřepisuje popis obrázku). Vrací pole nebo chybu (s poli pro znovuvykreslení).
   */
  async function ctiFormular(
    req: FastifyRequest,
    typ: TypObsahu,
    o: WebObsah | null,
    b: Telo,
    prisne: boolean,
    zapisovat = true,
  ): Promise<{ pole: PoleObsahu; chyba?: string }> {
    const zaklad = o ? poleProEditor(o) : PRAZDNA_POLE;
    const pole: PoleObsahu = { ...zaklad };
    pole.titulek = jeden(b.titulek).slice(0, 250);
    pole.perex = jeden(b.perex).slice(0, 600);
    pole.obsah_html = sanitizuj(jeden(b.obsah_html));
    if (b.slug !== undefined) pole.slug = jeden(b.slug);
    if (typ === 'stranka' || typ === 'odkaz') {
      const nad = jeden(b.nadrazena_id) || null;
      const platna = nad ? (await s.obsah.moznaNadrazena(o?.id ?? null)).some((x) => x.id === nad) : true;
      pole.nadrazena_id = platna && !(o && nad && (await s.obsah.maDeti(o.id))) ? nad : null;
      pole.v_menu = jeden(b.v_menu) === 'ano';
    }
    if (typ === 'odkaz') {
      const url = jeden(b.odkaz_url);
      pole.odkaz_url = /^(\/(?!\/)|https?:\/\/)/.test(url) ? url.slice(0, 500) : '';
    }
    if (typ === 'aktualita') {
      pole.kategorie_id = Number(jeden(b.kategorie_id)) || null;
      const d = jeden(b.datum);
      const cas = /^(\d{1,2}):(\d{2})$/.exec(jeden(b.cas));
      const kdy = d ? casPraha(d, cas ? Number(cas[1]) : 8, cas ? Number(cas[2]) : 0) : null;
      pole.datum = (kdy ?? new Date()).toISOString();
    }
    if (typ === 'akce') {
      pole.akce_cely_den = jeden(b.cely_den) === 'ano';
      pole.akce_misto = jeden(b.misto).slice(0, 200);
      const cas = (v: unknown, vychozi: [number, number]) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(jeden(v));
        return m ? [Number(m[1]), Number(m[2])] : vychozi;
      };
      const [h1, m1] = pole.akce_cely_den ? [0, 0] : cas(b.cas_od, [18, 0]);
      const zac = jeden(b.datum_od) ? casPraha(jeden(b.datum_od), h1!, m1!) : null;
      const dDo = jeden(b.datum_do) || (jeden(b.cas_do) ? jeden(b.datum_od) : '');
      const [h2, m2] = pole.akce_cely_den ? [23, 59] : cas(b.cas_do, [23, 59]);
      const kon = dDo ? casPraha(dDo, h2!, m2!) : null;
      pole.datum = zac ? zac.toISOString() : null;
      pole.akce_konec = kon && zac && kon > zac ? kon.toISOString() : null;
      if (prisne && !zac) return { pole, chyba: t('web.chyba_akce_datum') };
    }
    // úvodní obrázek
    if (jeden(b.odebrat_obrazek) === 'ano') pole.obrazek_id = null;
    const alt = jeden(b.obrazek_alt).slice(0, 300);
    const nahrany = zapisovat ? souboryZPole(req, 'obrazek')[0] : undefined;
    if (!zapisovat) {
      // náhled: nově vybraný obrázek se neukládá (zobrazí se po uložení), popis jen pro zobrazení
    } else if (nahrany) {
      const v = await app.soubory.uloz({
        data: await fs.readFile(nahrany.cesta),
        nazev: nahrany.nazev,
        druh: 'obrazek',
        nahralId: req.uzivatel!.id,
        alt,
      });
      if ('chyba' in v) return { pole, chyba: chybaSouboruText(t, v.chyba) };
      if (!v.soubor.mime.startsWith('image/')) return { pole, chyba: chybaSouboruText(t, 'typ') };
      pole.obrazek_id = v.soubor.id;
    } else if (pole.obrazek_id && b.obrazek_alt !== undefined) {
      await app.soubory.nastavAlt(pole.obrazek_id, alt);
    }
    if (prisne) {
      if (!pole.titulek) return { pole, chyba: t('web.chyba_titulek') };
      if (typ === 'odkaz' && !pole.odkaz_url) return { pole, chyba: t('web.chyba_odkaz') };
      if (pole.obrazek_id && !alt) return { pole, chyba: t('web.chyba_obrazek_alt') };
      const bezAlt = obrazkyBezAlt(pole.obsah_html);
      if (bezAlt) return { pole, chyba: t('web.chyba_alt', { n: bezAlt }) };
    }
    if (!pole.titulek) pole.titulek = t('web.bez_nazvu');
    return { pole };
  }

  async function ulozZFormulare(
    req: FastifyRequest<{ Body: Telo }>,
    reply: FastifyReply,
    typ: TypObsahu,
    o: WebObsah | null,
  ) {
    const b = req.body ?? {};
    const akce = jeden(b.akce) === 'zverejnit' ? 'zverejnit' : 'koncept';
    const { pole, chyba } = await ctiFormular(req, typ, o, b, akce === 'zverejnit');
    if (chyba) return editor(req, reply.code(400), typ, o, pole, { chyba });
    const id = await s.obsah.uloz(o?.id ?? null, typ, pole, akce, req.uzivatel!.id, req.ip);
    const ulozeny = (await s.obsah.podleId(id))!;
    const url = await s.obsah.url(ulozeny);
    req.session.flash =
      akce === 'zverejnit'
        ? { typ: 'ok', text: t('web.zverejneno_' + typ), odkaz: { url, text: t('web.zobrazit') } }
        : {
            typ: 'info',
            text:
              ulozeny.stav === 'zverejneno' ? t('web.koncept_ulozen_zverejneny') : t('web.koncept_ulozen'),
          };
    return reply.redirect(`/sprava/web/obsah/${id}`);
  }

  app.post<{ Querystring: { typ?: string }; Body: Telo }>(
    '/sprava/web/novy',
    { preHandler: redaktor },
    async (req, reply) => {
      const typ = (TYPY as string[]).includes(jeden(req.body?.typ))
        ? (jeden(req.body?.typ) as TypObsahu)
        : 'aktualita';
      return ulozZFormulare(req, reply, typ, null);
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/obsah/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const o = await s.obsah.podleId(req.params.id);
      if (!o) return reply.callNotFound();
      return ulozZFormulare(req, reply, o.typ, o);
    },
  );

  // automatické ukládání z editoru (JSON, CSRF v hlavičce). Nový obsah se při prvním uložení založí jako koncept.
  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/obsah/:id/autosave',
    { preHandler: redaktor },
    async (req, reply) => {
      const nove = req.params.id === 'novy';
      const o = nove ? null : await s.obsah.podleId(req.params.id);
      if (!nove && !o) return reply.code(404).send({ ok: false });
      const typ =
        o?.typ ??
        ((TYPY as string[]).includes(jeden(req.body?.typ))
          ? (jeden(req.body?.typ) as TypObsahu)
          : 'aktualita');
      const { pole } = await ctiFormular(req, typ, o ?? null, req.body ?? {}, false);
      const id = await s.obsah.uloz(o?.id ?? null, typ, pole, 'autosave', req.uzivatel!.id, req.ip);
      return reply.send({
        ok: true,
        id,
        cas: new Date().toLocaleTimeString('cs-CZ', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Prague',
        }),
      });
    },
  );

  // náhled: vykreslí veřejnou podobu z (neuloženého) formuláře
  app.post<{ Body: Telo }>('/sprava/web/nahled', { preHandler: redaktor }, async (req, reply) => {
    const b = req.body ?? {};
    const id = jeden(b.id);
    const o = id ? ((await s.obsah.podleId(id)) ?? null) : null;
    const typ =
      o?.typ ?? ((TYPY as string[]).includes(jeden(b.typ)) ? (jeden(b.typ) as TypObsahu) : 'aktualita');
    const { pole } = await ctiFormular(
      req,
      typ,
      o,
      { ...b, odebrat_obrazek: jeden(b.odebrat_obrazek) },
      false,
      false,
    );
    const ulozeny = pole.obrazek_id ? await app.soubory.podleId(pole.obrazek_id) : undefined;
    const obrazek =
      ulozeny && b.obrazek_alt !== undefined
        ? { ...ulozeny, alt: jeden(b.obrazek_alt).slice(0, 300) }
        : ulozeny;
    const nahled = {
      ...(o ?? {}),
      ...pole,
      typ,
      datum: pole.datum ? new Date(pole.datum) : null,
      akce_konec: pole.akce_konec ? new Date(pole.akce_konec) : null,
    };
    return reply.view('web/obsah', {
      titulek: pole.titulek,
      castiObsahu: rozdelPodleVidei(pole.obsah_html, await s.videa.vTextu(pole.obsah_html, true)),
      o: nahled,
      obrazek,
      nahled: true,
      noindex: true,
      ...pomocnici,
    });
  });

  // obrázek vložený do textu editorem (fetch, JSON odpověď)
  app.post<{ Body: Telo }>('/sprava/web/obrazek', { preHandler: redaktor }, async (req, reply) => {
    const f = souboryZPole(req, 'obrazek')[0];
    if (!f) return reply.code(400).send({ chyba: t('soubory.chyba_prazdny') });
    if (f.oriznuto) return reply.code(400).send({ chyba: chybaSouboruText(t, 'velikost') });
    const v = await app.soubory.uloz({
      data: await fs.readFile(f.cesta),
      nazev: f.nazev,
      druh: 'obrazek',
      nahralId: req.uzivatel!.id,
      alt: jeden(req.body?.alt),
    });
    if ('chyba' in v) return reply.code(400).send({ chyba: chybaSouboruText(t, v.chyba) });
    if (!v.soubor.mime.startsWith('image/'))
      return reply.code(400).send({ chyba: chybaSouboruText(t, 'typ') });
    return reply.send({
      id: v.soubor.id,
      url: urlSouboru(v.soubor),
      sirka: v.soubor.sirka,
      vyska: v.soubor.vyska,
      navrhAlt: navrhAlt(f.nazev),
    });
  });

  app.post<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/zahodit',
    { preHandler: redaktor },
    async (req, reply) => {
      await s.obsah.zahodKoncept(req.params.id, req.uzivatel!.id);
      req.session.flash = { typ: 'info', text: t('web.koncept_zahozen') };
      return reply.redirect(`/sprava/web/obsah/${req.params.id}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/skryt',
    { preHandler: redaktor },
    async (req, reply) => {
      await s.obsah.skryj(req.params.id, req.uzivatel!.id, req.ip);
      req.session.flash = { typ: 'info', text: t('web.skryto') };
      return reply.redirect(`/sprava/web/obsah/${req.params.id}`);
    },
  );

  // smazání: potvrzovací stránka (funguje bez JS) → koš
  app.get<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/smazat',
    { preHandler: redaktor },
    async (req, reply) => {
      const o = await s.obsah.podleId(req.params.id);
      if (!o) return reply.callNotFound();
      return reply.view('web/sprava/smazat', {
        titulek: t('web.smazat_titulek'),
        o,
        maDeti: await s.obsah.maDeti(o.id),
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/smazat',
    { preHandler: redaktor },
    async (req, reply) => {
      const o = await s.obsah.podleId(req.params.id);
      if (!o) return reply.callNotFound();
      await s.obsah.doKose(o.id, true, req.uzivatel!.id, req.ip);
      req.session.flash = { typ: 'ok', text: t('web.v_kosi', { titulek: o.titulek }) };
      return reply.redirect(`/sprava/web/${SEKCE_TYPU[o.typ]}`);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/obnovit',
    { preHandler: redaktor },
    async (req, reply) => {
      await s.obsah.doKose(req.params.id, false, req.uzivatel!.id, req.ip);
      req.session.flash = { typ: 'ok', text: t('web.obnoveno') };
      return reply.redirect(`/sprava/web/obsah/${req.params.id}`);
    },
  );

  // revize
  app.get<{ Params: { id: string } }>(
    '/sprava/web/obsah/:id/revize',
    { preHandler: redaktor },
    async (req, reply) => {
      const o = await s.obsah.podleId(req.params.id);
      if (!o) return reply.callNotFound();
      const revize = await s.obsah.revize(o.id);
      return reply.view('web/sprava/revize', { titulek: t('web.revize'), o, revize, ...pomocnici });
    },
  );
  app.post<{ Params: { id: string; rid: string } }>(
    '/sprava/web/obsah/:id/revize/:rid',
    { preHandler: redaktor },
    async (req, reply) => {
      const ok = await s.obsah.obnovRevizi(req.params.id, Number(req.params.rid), req.uzivatel!.id, req.ip);
      req.session.flash = ok
        ? { typ: 'info', text: t('web.revize_nactena') }
        : { typ: 'chyba', text: t('app.chyba_404') };
      return reply.redirect(`/sprava/web/obsah/${req.params.id}`);
    },
  );

  app.get('/sprava/web/kos', { preHandler: redaktor }, async (req, reply) => {
    const [obsah, galerie, dokumenty, dotace, videa] = await Promise.all([
      s.obsah.vKosi(),
      s.galerie.seznam({ verejne: false, kos: true }),
      s.dokumenty.seznam(true),
      s.dotace.seznam(true),
      s.videa.seznam({ verejne: false, kos: true }),
    ]);
    return reply.view('web/sprava/kos', {
      titulek: t('web.kos'),
      obsah,
      galerie,
      videa,
      dokumenty,
      dotace,
      jeSpravce: maRoli(req.uzivatel, 'spravce'),
    });
  });
}

/** návrh alternativního textu z názvu souboru — jen když název obsahuje slova (ne IMG_1234) */
export function navrhAlt(nazev: string): string {
  const z = nazev
    .replace(/\.[a-z0-9]+$/i, '')
    // varianty velikosti a technické přípony z WordPressu: -150x150, -scaled, -e1748421680105
    .replace(/[-_](\d+x\d+|scaled|e\d{9,}|\d{1,2})(?=$|[-_])/gi, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    !/[a-zA-ZÀ-ž]{3,}/.test(z) ||
    /^(img|dsc|dscn|pxl|photo|image|screenshot|snimek|foto|dji|gopr|mvimg|wp|pano|p|dcim)\s*\d/i.test(z)
  )
    return '';
  return z.charAt(0).toUpperCase() + z.slice(1);
}
