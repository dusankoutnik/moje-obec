// Správa webu — Vzhled webu: schéma, písmo, velikost, znak, fotky pozadí; náhled a vrácení zpět.
import type { FastifyInstance } from 'fastify';
import { kontrast, paleta } from '../../../lib/barvy.js';
import { oklchNaHex } from '../../../lib/oklch.js';
import { SCHEMATA, schemaPodleId } from '../schemata.js';
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
} from '../pisma.js';
import { STYLY_NAZVU, type NazevStyl, type UlozenyVzhled } from '../vzhled.js';
import type { WebSluzby } from '../index.js';
import { kontextSpravy, type Telo, jeden, vice } from './spolecne.js';

export default async function webSpravaVzhled(app: FastifyInstance, s: WebSluzby) {
  const { t, spravce, ulozObrazky } = kontextSpravy(app);

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
}
