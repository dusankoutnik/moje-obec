// Správa dalšího obsahu webu: fotogalerie (víc fotek najednou), dokumenty ke stažení, dotace (průvodce ve třech
// krocích s náhledem pásu log), vzhled webu (barva s kontrolou kontrastu, znak, úvodní fotka), přesměrování.
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { zapisAudit } from '../../lib/audit.js';
import { kontrast, paleta } from '../../lib/barvy.js';
import { oklchNaHex } from '../../lib/oklch.js';
import { SCHEMATA, schemaPodleId } from './schemata.js';
import {
  fontFace,
  fontFaceRezu,
  jeVelikost,
  PISMA,
  RODINY,
  proNadpis,
  proTelo,
  rodinaCss,
  rodinaPodleId,
  rodinaRezu,
  slozeniSady,
} from './pisma.js';
import { STYLY_NAZVU, type NazevStyl, type UlozenyVzhled } from './vzhled.js';
import { datumPraha } from '../../lib/datum.js';
import { slugify } from '../../lib/slug.js';
import { chybaSouboruText, lidskaVelikost, popisTypu } from '../../lib/soubory.js';
import { souboryZPole } from '../../web/nahravani.js';
import { urlSouboru } from '../../web/soubory.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import type { WebSluzby } from './index.js';
import { navrhAlt } from './sprava.js';
import { PresmerovaniSluzba } from './dalsi.js';
import { jeBezpecnyOdkaz } from '../../lib/navrat.js';

type Telo = Record<string, string | string[] | undefined>;
const jeden = (v: unknown) =>
  (Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v)).trim();
const vice = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const jeDatum = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function webSpravaDalsi(app: FastifyInstance, s: WebSluzby) {
  const t = app.t;
  const redaktor = vyzadujRoli('web');
  const spravce = vyzadujRoli('spravce');
  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, datumPraha };

  /** uloží nahrané obrázky z pole formuláře; vrací id a chyby */
  async function ulozObrazky(
    req: FastifyRequest,
    pole: string,
    druh: 'obrazek' | 'logo',
    alt: (nazev: string, i: number) => string,
  ) {
    const ids: string[] = [];
    const chyby: string[] = [];
    let i = 0;
    for (const f of souboryZPole(req, pole)) {
      i++;
      if (f.oriznuto) {
        chyby.push(`${f.nazev}: ${chybaSouboruText(t, 'velikost')}`);
        continue;
      }
      const v = await app.soubory.uloz({
        data: await fs.readFile(f.cesta),
        nazev: f.nazev,
        druh,
        nahralId: req.uzivatel!.id,
        alt: alt(f.nazev, i),
      });
      if ('chyba' in v) chyby.push(`${f.nazev}: ${chybaSouboruText(t, v.chyba)}`);
      else if (!v.soubor.mime.startsWith('image/')) chyby.push(`${f.nazev}: ${chybaSouboruText(t, 'typ')}`);
      else ids.push(v.soubor.id);
    }
    return { ids, chyby };
  }

  // ---------- fotogalerie ----------
  app.get('/sprava/web/galerie', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/galerie', {
      titulek: t('web.galerie'),
      galerie: await s.galerie.seznam({ verejne: false }),
      ...pomocnici,
    }),
  );

  app.post<{ Body: Telo }>('/sprava/web/galerie', { preHandler: redaktor }, async (req, reply) => {
    const nazev = jeden(req.body?.nazev).slice(0, 200);
    if (!nazev) {
      req.session.flash = { typ: 'chyba', text: t('web.chyba_titulek') };
      return reply.redirect('/sprava/web/galerie');
    }
    const datum = jeden(req.body?.datum);
    const id = await s.galerie.uloz(
      null,
      {
        nazev,
        popis: jeden(req.body?.popis).slice(0, 2000),
        datum: jeDatum(datum) ? datum : datumPraha(new Date()),
      },
      req.uzivatel!.id,
    );
    const { ids, chyby } = await ulozObrazky(
      req,
      'fotky',
      'obrazek',
      (_n, i) => `${nazev} — ${t('web.fotografie')} ${i}`,
    );
    await s.galerie.pridejFotky(id, ids);
    req.session.flash = chyby.length
      ? { typ: 'chyba', text: chyby.join(' ') }
      : { typ: 'ok', text: t('web.galerie_zalozena', { n: ids.length }) };
    return reply.redirect(`/sprava/web/galerie/${id}`);
  });

  app.get<{ Params: { id: string } }>(
    '/sprava/web/galerie/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const g = await s.galerie.podleId(req.params.id);
      if (!g) return reply.callNotFound();
      return reply.view('web/sprava/galerie-detail', {
        titulek: g.nazev,
        g,
        fotky: await s.galerie.fotky(g.id),
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Querystring: { foto?: string }; Body: Telo }>(
    '/sprava/web/galerie/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const g = await s.galerie.podleId(req.params.id);
      if (!g) return reply.callNotFound();
      const b = req.body ?? {};
      const akce = jeden(b.akce);
      if (akce === 'kos' || akce === 'obnovit') {
        await s.galerie.doKose(g.id, akce === 'kos', req.uzivatel!.id);
        req.session.flash = {
          typ: 'ok',
          text: akce === 'kos' ? t('web.v_kosi', { titulek: g.nazev }) : t('web.obnoveno'),
        };
        return reply.redirect(akce === 'kos' ? '/sprava/web/galerie' : `/sprava/web/galerie/${g.id}`);
      }
      const nazev = jeden(b.nazev).slice(0, 200) || g.nazev;
      const datum = jeden(b.datum);
      await s.galerie.uloz(
        g.id,
        { nazev, popis: jeden(b.popis).slice(0, 2000), datum: jeDatum(datum) ? datum : g.datum },
        req.uzivatel!.id,
      );
      // popisky a alternativní texty fotek
      const fotky = await s.galerie.fotky(g.id);
      let bezAlt = 0;
      for (const f of fotky) {
        const alt = b[`alt_${f.id}`];
        if (alt !== undefined) {
          const a = jeden(alt).slice(0, 300);
          await app.soubory.nastavAlt(f.id, a);
          if (!a) bezAlt++;
        } else if (!f.alt) bezAlt++;
        if (b[`popisek_${f.id}`] !== undefined)
          await s.galerie.nastavPopisek(g.id, f.id, jeden(b[`popisek_${f.id}`]).slice(0, 300));
      }
      await s.galerie.odeberFotky(g.id, vice(b.odebrat).map(String));
      const { ids, chyby } = await ulozObrazky(
        req,
        'fotky',
        'obrazek',
        (_n, i) => `${nazev} — ${t('web.fotografie')} ${fotky.length + i}`,
      );
      await s.galerie.pridejFotky(g.id, ids);
      if (akce === 'nahoru' || akce === 'dolu') {
        const foto = jeden(req.query.foto);
        await s.galerie.posunFotku(g.id, foto, akce);
        return reply.redirect(`/sprava/web/galerie/${g.id}#f-${foto}`);
      }
      if (akce === 'zverejnit' || akce === 'skryt') {
        if (akce === 'zverejnit' && bezAlt) {
          req.session.flash = { typ: 'chyba', text: t('web.chyba_alt', { n: bezAlt }) };
          return reply.redirect(`/sprava/web/galerie/${g.id}`);
        }
        await s.galerie.nastavStav(g.id, akce === 'zverejnit' ? 'zverejneno' : 'koncept', req.uzivatel!.id);
      }
      req.session.flash = chyby.length
        ? { typ: 'chyba', text: chyby.join(' ') }
        : akce === 'zverejnit'
          ? {
              typ: 'ok',
              text: t('web.galerie_zverejnena'),
              odkaz: { url: `/galerie/${(await s.galerie.podleId(g.id))!.slug}`, text: t('web.zobrazit') },
            }
          : {
              typ: 'ok',
              text: t('app.ulozeno') + (ids.length ? ' ' + t('web.fotek_pridano', { n: ids.length }) : ''),
            };
      return reply.redirect(`/sprava/web/galerie/${g.id}`);
    },
  );

  // ---------- dokumenty ke stažení ----------
  app.get('/sprava/web/dokumenty', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/dokumenty', {
      titulek: t('web.dokumenty'),
      dokumenty: await s.dokumenty.seznam(),
      skupiny: await s.dokumenty.skupiny(),
      ...pomocnici,
    }),
  );

  app.post<{ Body: Telo }>('/sprava/web/dokumenty', { preHandler: redaktor }, async (req, reply) => {
    const b = req.body ?? {};
    const akce = jeden(b.akce);
    if (akce === 'kos' || akce === 'obnovit') {
      await s.dokumenty.doKose(jeden(b.id), akce === 'kos', req.uzivatel!.id);
      req.session.flash = {
        typ: 'ok',
        text: akce === 'kos' ? t('web.v_kosi', { titulek: '' }) : t('web.obnoveno'),
      };
      return reply.redirect(akce === 'kos' ? '/sprava/web/dokumenty' : '/sprava/web/kos');
    }
    if (akce === 'upravit') {
      await s.dokumenty.uprav(jeden(b.id), {
        nazev: jeden(b.nazev).slice(0, 250),
        popis: jeden(b.popis).slice(0, 1000),
        skupina: jeden(b.skupina).slice(0, 100),
      });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const f = souboryZPole(req, 'soubor')[0];
    if (!f) {
      req.session.flash = { typ: 'chyba', text: t('web.chyba_soubor') };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const v = await app.soubory.uloz({
      data: await fs.readFile(f.cesta),
      nazev: f.nazev,
      druh: 'dokument',
      nahralId: req.uzivatel!.id,
    });
    if ('chyba' in v) {
      req.session.flash = { typ: 'chyba', text: chybaSouboruText(t, v.chyba) };
      return reply.redirect('/sprava/web/dokumenty');
    }
    const nazev = jeden(b.nazev).slice(0, 250) || f.nazev.replace(/\.[^.]+$/, '');
    await s.dokumenty.pridej(
      {
        nazev,
        popis: jeden(b.popis).slice(0, 1000),
        skupina: jeden(b.skupina).slice(0, 100),
        souborId: v.soubor.id,
      },
      req.uzivatel!.id,
    );
    req.session.flash = { typ: 'ok', text: t('web.dokument_pridan', { nazev }) };
    return reply.redirect('/sprava/web/dokumenty');
  });

  // ---------- dotace (průvodce: 1 údaje → 2 loga → 3 kdy zobrazovat) ----------
  app.get('/sprava/web/dotace', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/dotace', {
      titulek: t('web.dotace'),
      dotace: await s.dotace.seznam(),
      dnes: datumPraha(new Date()),
      ...pomocnici,
    }),
  );

  const krok1 = async (id: string | null) => {
    const d = id ? await s.dotace.podleId(id) : undefined;
    return { titulek: t('web.dotace_krok1'), d, f: d ?? {}, krok: 1 };
  };
  app.get('/sprava/web/dotace/nova', { preHandler: redaktor }, async (_req, reply) =>
    reply.view('web/sprava/dotace-krok', await krok1(null)),
  );
  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const v = await krok1(req.params.id);
      if (!v.d) return reply.callNotFound();
      return reply.view('web/sprava/dotace-krok', v);
    },
  );

  app.post<{ Params: { id?: string }; Body: Telo }>(
    '/sprava/web/dotace/:id?',
    { preHandler: redaktor },
    async (req, reply) => {
      const b = req.body ?? {};
      const id = req.params.id && req.params.id !== 'nova' ? req.params.id : null;
      if (jeden(b.akce) === 'kos' || jeden(b.akce) === 'obnovit') {
        await s.dotace.doKose(id!, jeden(b.akce) === 'kos', req.uzivatel!.id);
        req.session.flash = {
          typ: 'ok',
          text: jeden(b.akce) === 'kos' ? t('web.v_kosi', { titulek: '' }) : t('web.obnoveno'),
        };
        return reply.redirect('/sprava/web/dotace');
      }
      const projekt = jeden(b.projekt).slice(0, 300);
      const odkaz = jeden(b.odkaz);
      const data = {
        projekt,
        poskytovatel: jeden(b.poskytovatel).slice(0, 300),
        text: jeden(b.text).slice(0, 2000),
        odkaz: /^https?:\/\//.test(odkaz) ? odkaz.slice(0, 500) : '',
      };
      if (!projekt)
        return reply
          .code(400)
          .view('web/sprava/dotace-krok', { ...(await krok1(id)), f: data, chyba: t('web.chyba_projekt') });
      const novyId = await s.dotace.uloz(id, data, req.uzivatel!.id);
      return reply.redirect(`/sprava/web/dotace/${novyId}/loga`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id/loga',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      // náhled pásu: tato dotace mezi ostatními, které se už zobrazují
      const ostatni = (await s.dotace.aktivni()).filter((x) => x.id !== d.id);
      return reply.view('web/sprava/dotace-krok', {
        titulek: t('web.dotace_krok2'),
        d,
        loga: await s.dotace.loga(d.id),
        ostatni,
        krok: 2,
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/dotace/:id/loga',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      const b = req.body ?? {};
      for (const l of await s.dotace.loga(d.id)) {
        const a = b[`alt_${l.id}`];
        if (a !== undefined) await app.soubory.nastavAlt(l.id, jeden(a).slice(0, 300));
      }
      if (jeden(b.odebrat)) await s.dotace.odeberLogo(d.id, jeden(b.odebrat));
      const { ids, chyby } = await ulozObrazky(
        req,
        'loga',
        'logo',
        (n) => navrhAlt(n) || `${t('web.logo')} ${d.poskytovatel || d.projekt}`,
      );
      await s.dotace.pridejLoga(d.id, ids);
      if (chyby.length) req.session.flash = { typ: 'chyba', text: chyby.join(' ') };
      const dal = jeden(b.akce) === 'dal';
      if (dal) {
        const loga = await s.dotace.loga(d.id);
        if (!loga.length) {
          req.session.flash = { typ: 'chyba', text: t('web.chyba_logo') };
          return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
        }
        if (loga.some((l) => !l.alt)) {
          req.session.flash = {
            typ: 'chyba',
            text: t('web.chyba_alt', { n: loga.filter((l) => !l.alt).length }),
          };
          return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
        }
        return reply.redirect(`/sprava/web/dotace/${d.id}/zobrazeni`);
      }
      return reply.redirect(`/sprava/web/dotace/${d.id}/loga`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/sprava/web/dotace/:id/zobrazeni',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      return reply.view('web/sprava/dotace-krok', {
        titulek: t('web.dotace_krok3'),
        d,
        loga: await s.dotace.loga(d.id),
        krok: 3,
        f: d,
        ...pomocnici,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/web/dotace/:id/zobrazeni',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await s.dotace.podleId(req.params.id);
      if (!d) return reply.callNotFound();
      const b = req.body ?? {};
      const od = jeden(b.zobrazit_od);
      const doo = jeden(b.zobrazit_do);
      const f = {
        ...d,
        zobrazit_od: od,
        zobrazit_do: doo || null,
        v_paticce: jeden(b.v_paticce) === 'ano',
        poradi: Number(jeden(b.poradi)) || 100,
      };
      const chyba = !jeDatum(od)
        ? t('web.chyba_datum')
        : doo && (!jeDatum(doo) || doo < od)
          ? t('web.chyba_datum_do')
          : null;
      if (chyba)
        return reply.code(400).view('web/sprava/dotace-krok', {
          titulek: t('web.dotace_krok3'),
          d,
          loga: await s.dotace.loga(d.id),
          krok: 3,
          f,
          chyba,
          ...pomocnici,
        });
      await s.dotace.zobrazeni(
        d.id,
        { od, do: doo || null, vPaticce: f.v_paticce, poradi: f.poradi },
        req.uzivatel!.id,
      );
      const dnes = datumPraha(new Date());
      req.session.flash = {
        typ: 'ok',
        text:
          od <= dnes
            ? t('web.dotace_hotovo')
            : t('web.dotace_hotovo_pozdeji', { datum: od.split('-').reverse().join('. ') }),
      };
      return reply.redirect('/sprava/web/dotace');
    },
  );

  // ---------- vzhled: schéma, písmo, velikost, znak, fotky pozadí; náhled a vrácení zpět ----------
  app.get('/sprava/web/vzhled', { preHandler: spravce }, async (req, reply) => {
    const v = await s.vzhled.nacti();
    const pozadi = (v.ulozeno.pozadi_ids ?? []).map((id) => ({
      id,
      url: `/soubory/${id}/foto.jpg?v=nahled`,
    }));
    return reply.view('web/sprava/vzhled', {
      titulek: t('web.vzhled'),
      v,
      schemata: SCHEMATA.map((sch) => ({
        ...sch,
        hex: {
          primarni: oklchNaHex(sch.primarni),
          naTmave: oklchNaHex(sch.naTmave),
          akcent: oklchNaHex(sch.akcent),
          aktivni: oklchNaHex(sch.aktivni),
          aktivniText: sch.aktivniText === 'bila' ? '#ffffff' : oklchNaHex(sch.tmava),
          tmava: oklchNaHex(sch.tmava),
        },
      })),
      pisma: PISMA.map((p) => ({
        ...p,
        rodina: rodinaCss(p, 'telo'),
        rodinaNadpis: rodinaCss(p, 'nadpis'),
        rodinaDisplay: rodinaCss(p, 'display'),
      })),
      // vlastní kombinace: katalog písem + co je teď zvolené (u hotové dvojice její složení)
      rodiny: RODINY.map((x) => ({
        id: x.id,
        nazev: x.nazev,
        popis: x.popis,
        rodina: rodinaRezu(x.titulek),
        vahaTitulku: Math.max(...x.titulek.vahy),
        telo: !!x.telo,
        nadpis: !!x.nadpis,
      })),
      proTelo: proTelo.map((x) => x.id),
      proNadpis: proNadpis.map((x) => x.id),
      slozeni: slozeniSady(v.pismo),
      // na této stránce se načítají všechna písma kvůli ukázkám
      fontyNavic:
        fontFace(PISMA) +
        fontFaceRezu(RODINY.flatMap((x) => [x.telo, x.nadpis, x.titulek].filter((r) => !!r))),
      pozadi,
      maPredchozi: !!v.ulozeno.predchozi,
      nahledAktivni: !!req.session.nahledVzhledu,
      kontrastBile: kontrast(v.barva, '#ffffff'),
    });
  });

  /** přečte volby z formuláře vzhledu (bez souborů) */
  function volbyVzhledu(b: Telo): UlozenyVzhled {
    const z: UlozenyVzhled = {};
    const schema = jeden(b.schema);
    if (schema === 'vlastni' || schemaPodleId(schema)) z.schema = schema;
    const barva = jeden(b.barva).toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(barva)) z.barva = barva;
    if (PISMA.some((p) => p.id === jeden(b.pismo))) z.pismo = jeden(b.pismo);
    if (jeden(b.pismo) === 'vlastni') {
      const tl = rodinaPodleId(jeden(b.pismo_telo));
      const nd = rodinaPodleId(jeden(b.pismo_nadpis));
      const ti = rodinaPodleId(jeden(b.pismo_titulek));
      if (tl?.telo && nd?.nadpis && ti) {
        z.pismo = 'vlastni';
        z.pismo_telo = tl.id;
        z.pismo_nadpis = nd.id;
        z.pismo_titulek = ti.id;
      }
    }
    if (jeVelikost(jeden(b.velikost))) z.velikost = jeden(b.velikost) as UlozenyVzhled['velikost'];
    const rezim = jeden(b.pozadi_rezim);
    if (rezim === 'pevne' || rezim === 'nahodne' || rezim === 'stridani') z.pozadi_rezim = rezim;
    if (b.pozadi_pevne !== undefined) z.pozadi_pevne = jeden(b.pozadi_pevne) || null;
    if (b.motto !== undefined) z.motto = jeden(b.motto).slice(0, 200);
    if (b.nazev !== undefined) z.nazev = jeden(b.nazev).trim().slice(0, 60);
    const styl = jeden(b.nazev_styl);
    if (STYLY_NAZVU.includes(styl as NazevStyl)) z.nazev_styl = styl as NazevStyl;
    return z;
  }

  app.post<{ Body: Telo }>('/sprava/web/vzhled', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    const zmena = volbyVzhledu(b);
    const stary = (await s.vzhled.nacti()).ulozeno;
    if (jeden(b.odebrat_znak) === 'ano') zmena.znak_id = null;
    const chyby: string[] = [];
    const znak = await ulozObrazky(req, 'znak', 'logo', () =>
      t('web.znak_alt', { obec: app.obec.obec.nazev }),
    );
    if (znak.ids[0]) zmena.znak_id = znak.ids[0];
    // fotky pozadí: nové přidat, zaškrtnuté odebrat (soubory zůstávají v úložišti)
    const odebrat = new Set(vice(b.odebrat_pozadi).map(String));
    const foto = await ulozObrazky(req, 'pozadi', 'obrazek', () =>
      t('web.pozadi_alt', { obec: app.obec.obec.nazev }),
    );
    chyby.push(...znak.chyby, ...foto.chyby);
    if (odebrat.size || foto.ids.length)
      zmena.pozadi_ids = [...(stary.pozadi_ids ?? []).filter((id) => !odebrat.has(id)), ...foto.ids].slice(
        0,
        20,
      );
    if (jeden(b.akce) === 'nahled') {
      req.session.nahledVzhledu = { ...(req.session.nahledVzhledu ?? {}), ...zmena };
      return reply.redirect('/');
    }
    await s.vzhled.uloz(zmena, req.uzivatel!.id, req.ip);
    req.session.nahledVzhledu = null;
    const novy = await s.vzhled.nacti();
    const p = paleta(novy.barva);
    req.session.flash = chyby.length
      ? { typ: 'chyba', text: chyby.join(' ') }
      : !novy.schema && p.upravena
        ? {
            typ: 'info',
            text: t('web.barva_upravena', { barva: p.primarni }),
            odkaz: { url: '/', text: t('web.zobrazit') },
          }
        : { typ: 'ok', text: t('web.vzhled_ulozen'), odkaz: { url: '/', text: t('web.zobrazit') } };
    return reply.redirect('/sprava/web/vzhled');
  });

  app.post('/sprava/web/vzhled/nahled-pouzit', { preHandler: spravce }, async (req, reply) => {
    if (req.session.nahledVzhledu) await s.vzhled.uloz(req.session.nahledVzhledu, req.uzivatel!.id, req.ip);
    req.session.nahledVzhledu = null;
    req.session.flash = { typ: 'ok', text: t('web.vzhled_ulozen') };
    return reply.redirect('/sprava/web/vzhled');
  });
  app.post('/sprava/web/vzhled/nahled-zrusit', { preHandler: spravce }, async (req, reply) => {
    req.session.nahledVzhledu = null;
    req.session.flash = { typ: 'info', text: t('web.nahled_zrusen') };
    return reply.redirect('/sprava/web/vzhled');
  });
  app.post('/sprava/web/vzhled/zpet', { preHandler: spravce }, async (req, reply) => {
    const ok = await s.vzhled.vratZpet(req.uzivatel!.id, req.ip);
    req.session.flash = ok
      ? { typ: 'ok', text: t('web.vzhled_vracen') }
      : { typ: 'info', text: t('web.vzhled_neni_predchozi') };
    return reply.redirect('/sprava/web/vzhled');
  });

  // ---------- kategorie aktualit ----------
  app.get('/sprava/web/kategorie', { preHandler: spravce }, async (_req, reply) =>
    reply.view('web/sprava/kategorie', {
      titulek: t('web.kategorie_aktualit'),
      kategorie: await s.obsah.kategorie(),
    }),
  );
  app.post<{ Body: Telo }>('/sprava/web/kategorie', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    const nazev = jeden(b.nazev).slice(0, 100);
    const id = Number(jeden(b.id)) || null;
    if (nazev) {
      if (id)
        await app.db
          .updateTable('web_kategorie')
          .set({ nazev, poradi: Number(jeden(b.poradi)) || 100 })
          .where('id', '=', id)
          .execute();
      else
        await app.db
          .insertInto('web_kategorie')
          .values({ nazev, slug: slugify(nazev, 40), poradi: Number(jeden(b.poradi)) || 100 })
          .onConflict((oc) => oc.column('slug').doNothing())
          .execute();
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'web.kategorie',
        detail: { id, nazev },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
    }
    return reply.redirect('/sprava/web/kategorie');
  });

  // ---------- přesměrování starých adres ----------
  app.get('/sprava/web/presmerovani', { preHandler: spravce }, async (_req, reply) =>
    reply.view('web/sprava/presmerovani', {
      titulek: t('web.presmerovani'),
      seznam: await s.presmerovani.seznam(),
    }),
  );
  app.post<{ Body: Telo }>('/sprava/web/presmerovani', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    if (jeden(b.akce) === 'smazat') await s.presmerovani.smaz(jeden(b.stara));
    else {
      const nova = jeden(b.nova);
      if (jeden(b.stara) && jeBezpecnyOdkaz(nova)) await s.presmerovani.pridej(jeden(b.stara), nova);
      else req.session.flash = { typ: 'chyba', text: t('web.chyba_presmerovani') };
    }
    await zapisAudit(app.db, {
      uzivatelId: req.uzivatel!.id,
      akce: 'web.presmerovani',
      detail: { stara: PresmerovaniSluzba.normalizuj(jeden(b.stara)) },
      ip: req.ip,
    });
    return reply.redirect('/sprava/web/presmerovani');
  });
}
