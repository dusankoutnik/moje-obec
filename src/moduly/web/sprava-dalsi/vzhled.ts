// Správa webu — Vzhled webu: schéma, písmo, velikost, znak, fotky pozadí; náhled a vrácení zpět.
import type { FastifyInstance } from 'fastify';
import { kontrast, paleta } from '../../../lib/barvy.js';
import { oklchNaHex } from '../../../lib/oklch.js';
import {
  hexVlastniho,
  overSchema,
  ROLE_VLASTNIHO,
  SCHEMATA,
  schemaPodleId,
  vlastniSchema,
  type VlastniBarvy,
} from '../schemata.js';
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
import {
  EFEKTY_MENU,
  SILY_EFEKTU,
  STYLY_NAZVU,
  UMISTENI_POCASI,
  ZOBRAZENI_POCASI,
  type EfektMenu,
  type ZobrazeniPocasi,
  type NazevStyl,
  type SilaEfektu,
  type UlozenyVzhled,
  type UmisteniPocasi,
} from '../vzhled.js';
import type { WebSluzby } from '../index.js';
import { vyzadujRoli } from '../../ucty/opravneni.js';
import { kontextSpravy, type Telo, jeden, vice } from './spolecne.js';
import { nazevInfokanalu, VYCHOZI_NAZEV_INFOKANALU } from '../../infokanal/nazev.js';

export default async function webSpravaVzhled(app: FastifyInstance, s: WebSluzby) {
  const { t, ulozObrazky } = kontextSpravy(app);
  // vzhled webu (i náhled, uložení a vrácení) jen provozovatel instalace — rozhodnutí 2026-10-26
  const provozovatel = vyzadujRoli('provozovatel');

  // ---------- vzhled: schéma, písmo, velikost, znak, fotky pozadí; náhled a vrácení zpět ----------
  app.get('/sprava/web/vzhled', { preHandler: provozovatel }, async (req, reply) => {
    const v = await s.vzhled.nacti();
    const pozadi = (v.ulozeno.pozadi_ids ?? []).map((id) => ({
      id,
      url: `/soubory/${id}/foto.jpg?v=nahled`,
    }));
    return reply.view('web/sprava/vzhled', {
      titulek: t('web.vzhled'),
      v,
      // název infokanálu, když ho vzhled nenastaví (obec.yml, jinak „Hlášení obce“)
      nazevInfokanaluVychozi: app.obec.texty.nazev_infokanalu.trim() || VYCHOZI_NAZEV_INFOKANALU,
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
      // volba umístění dlaždice počasí jen když je modul počasí na instalaci (obec.yml + souřadnice)
      pocasiDostupne: !!app.pocasi,
      // vlastní barevné schéma: barvy do formuláře (uložené, nebo odvozené z aktuálního vzhledu) + kontrola kontrastu
      vlastni: (() => {
        const ul = v.ulozeno.schema_vlastni;
        const sch = ul ? vlastniSchema(ul).schema : v.schema;
        const hex = sch ? hexVlastniho(sch) : null;
        return {
          barvy: ul ?? hex ?? { primarni: v.barva, akcent: '#ffd600', tmava: '#151a16' },
          rucne: { na_tmave: !!ul?.na_tmave, aktivni: !!ul?.aktivni },
          vysledek: ul ? hexVlastniho(vlastniSchema(ul).schema) : null,
          kontrola: ul ? overSchema(vlastniSchema(ul).schema) : [],
        };
      })(),
    });
  });

  /** přečte volby z formuláře vzhledu (bez souborů) */
  function volbyVzhledu(b: Telo): UlozenyVzhled {
    const z: UlozenyVzhled = {};
    const schema = jeden(b.schema);
    if (schema === 'vlastni' || schema === 'vlastni-schema' || schemaPodleId(schema)) z.schema = schema;
    // barvy vlastního schématu (nepovinné role jen se zatržítkem „nastavit ručně“)
    const hex = (x: unknown) => {
      const h = jeden(x).toLowerCase();
      return /^#[0-9a-f]{6}$/.test(h) ? h : undefined;
    };
    if (hex(b.vs_primarni) && hex(b.vs_akcent) && hex(b.vs_tmava)) {
      const vb: VlastniBarvy = {
        primarni: hex(b.vs_primarni)!,
        akcent: hex(b.vs_akcent)!,
        tmava: hex(b.vs_tmava)!,
      };
      for (const r of ROLE_VLASTNIHO.slice(3)) {
        const h = hex(b[`vs_${r}`]);
        if (jeden(b[`vs_${r}_rucne`]) === 'ano' && h) vb[r] = h;
      }
      z.schema_vlastni = vb;
    }
    if (b.volt_logo_odeslano !== undefined) z.volt_logo = jeden(b.volt_logo) === 'ano';
    const zobr = jeden(b.pocasi_zobrazeni);
    if ((ZOBRAZENI_POCASI as string[]).includes(zobr)) z.pocasi_zobrazeni = zobr as ZobrazeniPocasi;
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
    const efekt = jeden(b.efekt_menu);
    if ((EFEKTY_MENU as string[]).includes(efekt)) z.efekt_menu = efekt as EfektMenu;
    const sila = jeden(b.efekt_sila);
    if ((SILY_EFEKTU as string[]).includes(sila)) z.efekt_sila = sila as SilaEfektu;
    const pocasi = jeden(b.pocasi_umisteni);
    if ((UMISTENI_POCASI as string[]).includes(pocasi)) z.pocasi_umisteni = pocasi as UmisteniPocasi;
    // ztmavení fotky v procentech (posuvník 0–80) → 0–0,8; sklo a podklad textu dopočítá vzhled podle kontrastu
    if (b.zavoj !== undefined) {
      const n = Number(jeden(b.zavoj));
      if (Number.isFinite(n)) z.zavoj = Math.min(80, Math.max(0, Math.round(n))) / 100;
    }
    if (b.motto !== undefined) z.motto = jeden(b.motto).slice(0, 200);
    if (b.nazev !== undefined) z.nazev = jeden(b.nazev).trim().slice(0, 60);
    if (b.nazev_infokanalu !== undefined)
      z.nazev_infokanalu = jeden(b.nazev_infokanalu).replace(/\s+/g, ' ').trim().slice(0, 40);
    const styl = jeden(b.nazev_styl);
    if (STYLY_NAZVU.includes(styl as NazevStyl)) z.nazev_styl = styl as NazevStyl;
    return z;
  }

  app.post<{ Body: Telo }>('/sprava/web/vzhled', { preHandler: provozovatel }, async (req, reply) => {
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
    const nazevIkPred = nazevInfokanalu(app);
    await s.vzhled.uloz(zmena, req.uzivatel!.id, req.ip);
    req.session.nahledVzhledu = null;
    // přejmenování infokanálu: položky menu webu s odkazem na /infokanal, které nesly dosavadní název, se přejmenují
    // taky (vlastní název položky, který redaktor zadal jinak, zůstane)
    const nazevIkPo = nazevInfokanalu(app);
    if (nazevIkPo !== nazevIkPred) {
      const r = await app.db
        .updateTable('web_obsah')
        .set({ titulek: nazevIkPo })
        .where('typ', '=', 'odkaz')
        .where('odkaz_url', 'in', ['/infokanal', '/infokanal/'])
        .where('titulek', '=', nazevIkPred)
        .where('smazano_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows)) s.obsah.zmena();
    }
    const novy = await s.vzhled.nacti();
    const p = paleta(novy.barva);
    const upravy =
      novy.ulozeno.schema === 'vlastni-schema' && novy.ulozeno.schema_vlastni
        ? vlastniSchema(novy.ulozeno.schema_vlastni).upravy
        : [];
    req.session.flash = chyby.length
      ? { typ: 'chyba', text: chyby.join(' ') }
      : upravy.length
        ? {
            typ: 'info',
            text: t('web.vs_upraveno', {
              seznam: upravy.map((u) => `${t('web.vs_role_' + u.role)} ${u.z} → ${u.na}`).join(', '),
            }),
            odkaz: { url: '/', text: t('web.zobrazit') },
          }
        : !novy.schema && p.upravena
          ? {
              typ: 'info',
              text: t('web.barva_upravena', { barva: p.primarni }),
              odkaz: { url: '/', text: t('web.zobrazit') },
            }
          : { typ: 'ok', text: t('web.vzhled_ulozen'), odkaz: { url: '/', text: t('web.zobrazit') } };
    return reply.redirect('/sprava/web/vzhled');
  });

  app.post('/sprava/web/vzhled/nahled-pouzit', { preHandler: provozovatel }, async (req, reply) => {
    if (req.session.nahledVzhledu) await s.vzhled.uloz(req.session.nahledVzhledu, req.uzivatel!.id, req.ip);
    req.session.nahledVzhledu = null;
    req.session.flash = { typ: 'ok', text: t('web.vzhled_ulozen') };
    return reply.redirect('/sprava/web/vzhled');
  });
  app.post('/sprava/web/vzhled/nahled-zrusit', { preHandler: provozovatel }, async (req, reply) => {
    req.session.nahledVzhledu = null;
    req.session.flash = { typ: 'info', text: t('web.nahled_zrusen') };
    return reply.redirect('/sprava/web/vzhled');
  });
  app.post('/sprava/web/vzhled/zpet', { preHandler: provozovatel }, async (req, reply) => {
    const ok = await s.vzhled.vratZpet(req.uzivatel!.id, req.ip);
    req.session.flash = ok
      ? { typ: 'ok', text: t('web.vzhled_vracen') }
      : { typ: 'info', text: t('web.vzhled_neni_predchozi') };
    return reply.redirect('/sprava/web/vzhled');
  });
}
