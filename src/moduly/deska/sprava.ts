// Správa úřední desky: vyvěšení dokumentu s přílohami, úpravy, předčasné sejmutí, koš, kategorie,
// povinně zveřejňované informace. Redaktor vkládá a upravuje; správce/admin vše.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { promises as fs } from 'node:fs';
import { zapisAudit } from '../../lib/audit.js';
import { casPraha, datumPraha, pridejDny } from '../../lib/datum.js';
import { bezDiakritiky } from '../../lib/kontakty.js';
import { sanitizuj, zkrat } from '../../lib/html.js';
import { slugify } from '../../lib/slug.js';
import { chybaSouboruText, lidskaVelikost, popisTypu } from '../../lib/soubory.js';
import { souboryZPole } from '../../web/nahravani.js';
import { urlSouboru } from '../../web/soubory.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { maRoli } from '../ucty/sluzba.js';
import { STRUKTURA_PI, vyplnPi } from './povinne.js';
import {
  TYPY_ROZPOCTU,
  zkontrolujDobu,
  type DataDokumentu,
  type DeskaSluzba,
  type TypRozpoctu,
} from './sluzba.js';

type Telo = Record<string, string | string[] | undefined>;
const jeden = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
const vice = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export default async function deskaSprava(app: FastifyInstance, z: { sluzba: DeskaSluzba }) {
  const { sluzba } = z;
  const t = app.t;
  const redaktor = vyzadujRoli('deska');
  const spravce = vyzadujRoli('spravce');
  const pomocnici = { lidskaVelikost, popisTypu, urlSouboru };

  app.get<{ Querystring: { stav?: string; q?: string } }>(
    '/sprava/deska',
    { preHandler: redaktor },
    async (req, reply) => {
      const stav =
        (['vyveseno', 'pripraveno', 'sejmuto', 'kos'] as const).find((s) => s === req.query.stav) ??
        'vyveseno';
      const dokumenty = await sluzba.proSpravu(stav, String(req.query.q ?? ''));
      const pocty = await sluzba.pocty();
      return reply.view('deska/sprava/seznam', {
        titulek: t('deska.sprava_titulek'),
        stav,
        q: req.query.q ?? '',
        dokumenty,
        pocty,
        jeSpravce: maRoli(req.uzivatel, 'spravce'),
      });
    },
  );

  async function formular(req: FastifyRequest, data: Record<string, unknown>) {
    const kategorie = await sluzba.kategorie();
    return {
      titulek: data.d ? t('deska.upravit') : t('deska.novy'),
      kategorie,
      typy: TYPY_ROZPOCTU,
      infokanal: app.obec.moduly.infokanal,
      dnes: datumPraha(new Date()),
      jeSpravce: maRoli(req.uzivatel, 'spravce'),
      prilohy: [],
      ...pomocnici,
      ...data,
    };
  }

  app.get<{ Querystring: { kategorie?: string } }>(
    '/sprava/deska/novy',
    { preHandler: redaktor },
    async (req, reply) => {
      const kategorie = await sluzba.kategorie();
      const k = kategorie.find((x) => x.slug === req.query.kategorie) ?? kategorie[0];
      const dnes = datumPraha(new Date());
      return reply.view(
        'deska/sprava/formular',
        await formular(req, {
          f: {
            kategorie_id: String(k?.id ?? ''),
            od: dnes,
            do: k && k.vychozi_dni > 0 ? pridejDny(dnes, k.vychozi_dni) : '',
            do_odvolani: k && k.vychozi_dni === 0 ? 'ano' : '',
            rok: String(new Date().getFullYear()),
          },
        }),
      );
    },
  );

  // společné čtení a kontrola formuláře; vrací data, nebo text chyby
  async function nactiFormular(b: Telo): Promise<{ data: DataDokumentu } | { chyba: string }> {
    const nazev = jeden(b.nazev).slice(0, 300);
    if (!nazev) return { chyba: t('deska.chyba_nazev') };
    const kat = await sluzba.kategoriePodleId(Number(jeden(b.kategorie_id)));
    if (!kat) return { chyba: t('deska.chyba_kategorie') };
    const od = jeden(b.od) || datumPraha(new Date());
    let do_: string | null = jeden(b.do) || null;
    if (jeden(b.do_odvolani) === 'ano') do_ = null;
    else if (!do_ && kat.vychozi_dni > 0) do_ = pridejDny(od, kat.vychozi_dni);
    const kontrola = zkontrolujDobu(kat, od, do_);
    if ('chyba' in kontrola) {
      if (kontrola.chyba === 'kratke')
        return {
          chyba: t('deska.chyba_kratke', {
            kategorie: kat.nazev,
            dni: kat.min_dni,
            datum: new Date(kontrola.minDo + 'T12:00:00Z').toLocaleDateString('cs-CZ'),
          }),
        };
      return { chyba: t(`deska.chyba_${kontrola.chyba}`) };
    }
    const typ = jeden(b.typ_rozpoctu);
    const typRozpoctu =
      kat.rozpocet && (TYPY_ROZPOCTU as readonly string[]).includes(typ) ? (typ as TypRozpoctu) : null;
    const rok = typRozpoctu ? Number(jeden(b.rok)) || null : null;
    if (typRozpoctu && (!rok || rok < 2000 || rok > 2100)) return { chyba: t('deska.chyba_rok') };
    return {
      data: {
        nazev,
        kategorieId: kat.id,
        cisloJednaci: jeden(b.cislo_jednaci).slice(0, 100),
        puvodce: jeden(b.puvodce).slice(0, 200),
        popis: jeden(b.popis).slice(0, 3000),
        od,
        do: do_,
        typRozpoctu,
        rok,
      },
    };
  }

  /**
   * Zákonná lhůta se počítá od skutečného vyvěšení — datum „od“ v minulosti by dokument jen naoko prodloužil.
   * Nový dokument: od nejdřív dnes (správce smí zpětně s důvodem, např. dokument visel na papírové desce).
   * Už vyvěšený dokument: změnit „od“ smí jen správce s důvodem. Vrací text chyby, nebo null.
   */
  function kontrolaData(
    req: FastifyRequest,
    b: Telo,
    od: string,
    puvodni?: { vyveseno_od: Date },
  ): { chyba: string } | { duvod: string | null } {
    const dnes = datumPraha(new Date());
    const zmeneno = puvodni ? datumPraha(puvodni.vyveseno_od) !== od : true;
    if (!zmeneno) return { duvod: null };
    const uzVisi = !!puvodni && puvodni.vyveseno_od <= new Date();
    if (od >= dnes && !uzVisi) return { duvod: null };
    if (!maRoli(req.uzivatel, 'spravce'))
      return { chyba: t(uzVisi ? 'deska.chyba_od_vyveseny' : 'deska.chyba_od_minulost') };
    const duvod = jeden(b.duvod_data).slice(0, 300);
    if (!duvod) return { chyba: t('deska.chyba_duvod_data') };
    return { duvod };
  }

  // přílohy z formuláře → úložiště; vrací id uložených a chyby jednotlivých souborů
  async function ulozPrilohy(req: FastifyRequest): Promise<{ ids: string[]; chyby: string[] }> {
    const ids: string[] = [];
    const chyby: string[] = [];
    for (const s of souboryZPole(req, 'prilohy')) {
      if (s.oriznuto) {
        chyby.push(`${s.nazev}: ${chybaSouboruText(t, 'velikost')}`);
        continue;
      }
      const v = await app.soubory.uloz({
        data: await fs.readFile(s.cesta),
        nazev: s.nazev,
        druh: 'dokument',
        nahralId: req.uzivatel!.id,
      });
      if ('chyba' in v) chyby.push(`${s.nazev}: ${chybaSouboruText(t, v.chyba)}`);
      else ids.push(v.soubor.id);
    }
    return { ids, chyby };
  }

  // „vyvěsit + rozeslat“: hlášení infokanálu s odkazem na dokument
  async function rozesli(req: FastifyRequest, dokumentId: string, data: DataDokumentu, b: Telo) {
    if (!app.obec.moduly.infokanal || jeden(b.rozeslat) !== 'ano') return null;
    const kategorie = (await app.infokanal.kategorie()).find((k) => k.slug === 'hlaseni');
    if (!kategorie) return null;
    const url = `${app.env.BASE_URL}/uredni-deska/${dokumentId}`;
    const prefix = app.obec.texty.sms_prefix;
    const vlastniSms = jeden(b.sms_text);
    const sms =
      vlastniSms ||
      `Na uredni desce: ${zkrat(bezDiakritiky(data.nazev), Math.max(40, 160 - prefix.length - url.length - 22))} ${url}`;
    const v = await app.infokanal.zalozHlaseni(req.uzivatel!.id, {
      kategorieId: kategorie.id,
      krizove: false,
      cil: 'vse',
      cilDetail: [],
      smsText: jeden(b.poslat_sms) === 'ano' ? sms : null,
      emailPredmet: t('deska.mail_predmet', { nazev: data.nazev }),
      emailText: [data.nazev, data.popis, `${t('deska.mail_odkaz')} ${url}`].filter(Boolean).join('\n\n'),
      // dokument vyvěšený dopředu se rozešle v den vyvěšení ráno
      naplanovanoNa: casPraha(data.od, 7)! > new Date() ? casPraha(data.od, 7) : null,
    });
    if ('chyba' in v) return null;
    await sluzba.nastavHlaseni(dokumentId, v.id);
    app.infokanalFronta.kopni();
    return v.prijemcu;
  }

  app.post<{ Body: Telo }>('/sprava/deska/novy', { preHandler: redaktor }, async (req, reply) => {
    const b = req.body ?? {};
    const v = await nactiFormular(b);
    if ('chyba' in v)
      return reply.code(400).view('deska/sprava/formular', await formular(req, { f: b, chyba: v.chyba }));
    const datum = kontrolaData(req, b, v.data.od);
    if ('chyba' in datum)
      return reply.code(400).view('deska/sprava/formular', await formular(req, { f: b, chyba: datum.chyba }));
    const prilohy = await ulozPrilohy(req);
    if (prilohy.chyby.length)
      return reply
        .code(400)
        .view('deska/sprava/formular', await formular(req, { f: b, chyba: prilohy.chyby.join(' ') }));
    const id = await sluzba.uloz(null, v.data, req.uzivatel!.id, req.ip);
    if (datum.duvod)
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'deska.zpetne_datum',
        detail: { id, od: v.data.od, duvod: datum.duvod },
        ip: req.ip,
      });
    await sluzba.pridejPrilohy(id, prilohy.ids);
    const prijemcu = await rozesli(req, id, v.data, b);
    const vyveseno = casPraha(v.data.od)! <= new Date();
    req.session.flash = {
      typ: 'ok',
      text:
        (vyveseno
          ? t('deska.vyveseno_ok')
          : t('deska.pripraveno_ok', { datum: v.data.od.split('-').reverse().join('. ') })) +
        (prijemcu !== null && prijemcu !== undefined ? ' ' + t('deska.rozeslano', { n: prijemcu }) : ''),
    };
    return reply.redirect(`/sprava/deska/${id}`);
  });

  app.get<{ Params: { id: string } }>('/sprava/deska/:id', { preHandler: redaktor }, async (req, reply) => {
    const d = await sluzba.detail(req.params.id);
    if (!d) return reply.callNotFound();
    const f = {
      nazev: d.nazev,
      kategorie_id: String(d.kategorie_id),
      cislo_jednaci: d.cislo_jednaci,
      puvodce: d.puvodce,
      popis: d.popis,
      od: datumPraha(d.vyveseno_od),
      do: d.sejmuto_do ? datumPraha(d.sejmuto_do) : '',
      do_odvolani: d.sejmuto_do ? '' : 'ano',
      typ_rozpoctu: d.typ_rozpoctu ?? '',
      rok: d.rok ? String(d.rok) : '',
    };
    return reply.view('deska/sprava/formular', await formular(req, { d, f, prilohy: d.prilohy }));
  });

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/deska/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const d = await sluzba.detail(req.params.id);
      if (!d) return reply.callNotFound();
      const b = req.body ?? {};
      const v = await nactiFormular(b);
      if ('chyba' in v)
        return reply
          .code(400)
          .view(
            'deska/sprava/formular',
            await formular(req, { d, f: b, chyba: v.chyba, prilohy: d.prilohy }),
          );
      const datum = kontrolaData(req, b, v.data.od, d);
      if ('chyba' in datum)
        return reply
          .code(400)
          .view(
            'deska/sprava/formular',
            await formular(req, { d, f: b, chyba: datum.chyba, prilohy: d.prilohy }),
          );
      const prilohy = await ulozPrilohy(req);
      await sluzba.uloz(d.id, v.data, req.uzivatel!.id, req.ip);
      if (datum.duvod)
        await zapisAudit(app.db, {
          uzivatelId: req.uzivatel!.id,
          akce: 'deska.zmena_data',
          detail: { id: d.id, z: datumPraha(d.vyveseno_od), na: v.data.od, duvod: datum.duvod },
          ip: req.ip,
        });
      await sluzba.pridejPrilohy(d.id, prilohy.ids);
      await sluzba.odeberPrilohy(d.id, vice(b.odebrat).map(String));
      req.session.flash = prilohy.chyby.length
        ? { typ: 'chyba', text: t('app.ulozeno') + ' ' + prilohy.chyby.join(' ') }
        : { typ: 'ok', text: t('deska.ulozeno_ok') };
      return reply.redirect(`/sprava/deska/${d.id}`);
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/deska/:id/sejmout',
    { preHandler: spravce },
    async (req, reply) => {
      const d = await sluzba.detail(req.params.id);
      if (!d) return reply.callNotFound();
      const duvod = jeden(req.body?.duvod).slice(0, 300);
      if (!duvod) {
        req.session.flash = { typ: 'chyba', text: t('deska.sejmout_duvod_chybi') };
        return reply.redirect(`/sprava/deska/${d.id}`);
      }
      const ok = await sluzba.sejmiHned(d.id, duvod, req.uzivatel!.id, req.ip);
      req.session.flash = ok
        ? { typ: 'ok', text: t('deska.sejmuto_ok') }
        : { typ: 'chyba', text: t('deska.sejmout_nevisi') };
      return reply.redirect(`/sprava/deska/${d.id}`);
    },
  );

  app.post<{ Params: { id: string }; Body: Telo }>(
    '/sprava/deska/:id/kos',
    { preHandler: spravce },
    async (req, reply) => {
      const obnovit = jeden(req.body?.akce) === 'obnovit';
      await sluzba.doKose(req.params.id, !obnovit, req.uzivatel!.id, req.ip);
      req.session.flash = { typ: 'ok', text: obnovit ? t('deska.obnoveno') : t('deska.v_kosi') };
      return reply.redirect(obnovit ? `/sprava/deska/${req.params.id}` : '/sprava/deska?stav=kos');
    },
  );

  // --- kategorie ---
  app.get('/sprava/deska/kategorie', { preHandler: spravce }, async (_req, reply) =>
    reply.view('deska/sprava/kategorie', {
      titulek: t('deska.kategorie'),
      kategorie: await sluzba.kategorie(false),
    }),
  );
  app.post<{ Body: Telo }>('/sprava/deska/kategorie', { preHandler: spravce }, async (req, reply) => {
    const b = req.body ?? {};
    const nazev = jeden(b.nazev).slice(0, 120);
    if (nazev) {
      const id = Number(jeden(b.id)) || null;
      await sluzba.ulozKategorii(
        id,
        {
          nazev,
          minDni: Math.max(0, Math.min(3650, Number(jeden(b.min_dni)) || 0)),
          vychoziDni: Math.max(0, Math.min(3650, Number(jeden(b.vychozi_dni)) || 0)),
          rozpocet: jeden(b.rozpocet) === 'ano',
          poradi: Number(jeden(b.poradi)) || 100,
          aktivni: id ? jeden(b.aktivni) === 'ano' : true,
          archivVerejny: jeden(b.archiv_verejny) === 'ano',
        },
        slugify(nazev, 40),
      );
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'deska.kategorie',
        detail: { id, nazev },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('app.ulozeno') };
    }
    return reply.redirect('/sprava/deska/kategorie');
  });

  // --- povinně zveřejňované informace ---
  const nactiPi = async () =>
    new Map(
      (await app.db.selectFrom('pi_body').select(['klic', 'obsah_html']).execute()).map((r) => [
        r.klic,
        r.obsah_html,
      ]),
    );

  app.get('/sprava/povinne-informace', { preHandler: spravce }, async (_req, reply) => {
    const body = vyplnPi(app.obec, await nactiPi(), { baseUrl: app.env.BASE_URL, deska: true });
    const chybi = body.filter((b) => b.stav === 'chybi').length;
    const vychozi = body.filter((b) => b.stav === 'vychozi').length;
    return reply.view('deska/sprava/povinne', { titulek: t('pi.titulek'), body, chybi, vychozi });
  });

  app.get<{ Params: { klic: string } }>(
    '/sprava/povinne-informace/:klic',
    { preHandler: spravce },
    async (req, reply) => {
      const bod = vyplnPi(app.obec, await nactiPi(), { baseUrl: app.env.BASE_URL, deska: true }).find(
        (b) => b.klic === req.params.klic && !b.skupina,
      );
      if (!bod) return reply.callNotFound();
      return reply.view('deska/sprava/povinne-bod', {
        titulek: `${bod.klic}. ${bod.nazev}`,
        bod,
        editor: true,
      });
    },
  );

  app.post<{ Params: { klic: string }; Body: Telo }>(
    '/sprava/povinne-informace/:klic',
    { preHandler: spravce },
    async (req, reply) => {
      const bod = STRUKTURA_PI.find((b) => b.klic === req.params.klic && !b.skupina);
      if (!bod) return reply.callNotFound();
      const b = req.body ?? {};
      const html = jeden(b.akce) === 'vychozi' ? '' : sanitizuj(jeden(b.obsah));
      await app.db
        .insertInto('pi_body')
        .values({ klic: bod.klic, obsah_html: html, upravil_id: req.uzivatel!.id })
        .onConflict((oc) =>
          oc
            .column('klic')
            .doUpdateSet({ obsah_html: html, upravil_id: req.uzivatel!.id, upraveno_at: new Date() }),
        )
        .execute();
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'pi.uprava',
        detail: { bod: bod.klic },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: t('pi.ulozeno', { bod: `${bod.klic}. ${bod.nazev}` }) };
      return reply.redirect('/sprava/povinne-informace');
    },
  );
}
