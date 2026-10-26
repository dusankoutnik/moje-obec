// Správa infokanálu úřadem: hlášení (seznam, nové, detail, zastavení), odběratelé (seznam, přidání úřadem).
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KanalPreference, PrilohaHlaseni } from '../../db/types.js';
import { chybaSouboruText, lidskaVelikost } from '../../lib/soubory.js';
import { souboryZPole } from '../../web/nahravani.js';
import { normalizujEmail, normalizujTelefon, smsSegmenty } from '../../lib/kontakty.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { textNaHtml, textZHtml, zkrat } from '../../lib/html.js';
import { MAX_PRILOH, MAX_PRILOH_EMAILEM, prilohyHtml, zpracujClanek, zpracujEmail } from './obsah.js';
import { PRAZDNA_POLE } from '../web/obsah.js';
import type { InfokanalSluzba } from './sluzba.js';
import { casPraha } from '../../lib/datum.js';
import { zapisAudit } from '../../lib/audit.js';

const vice = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** hodnota z <input type="datetime-local"> (YYYY-MM-DDTHH:MM) je čas v Praze, ne v pásmu serveru */
export function naplanovanoZFormulare(v: unknown): Date | null | 'neplatne' {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return 'neplatne';
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return 'neplatne';
  return casPraha(m[1]!, h, min) ?? 'neplatne';
}
import type { RozesilaciFronta } from './fronta.js';
import { predvyplneniZPrispevku } from './z-prispevku.js';

export default async function infokanalSprava(
  app: FastifyInstance,
  z: { sluzba: InfokanalSluzba; fronta: RozesilaciFronta },
) {
  const { sluzba, fronta } = z;
  const t = app.t;
  const redaktor = vyzadujRoli('redaktor');

  app.get('/infokanal/sprava', { preHandler: redaktor }, async (_req, reply) => {
    const hlaseni = await sluzba.seznamHlaseni();
    const stat = await sluzba.statistiky();
    return reply.view('infokanal/sprava/hlaseni', { titulek: t('infokanal.hlaseni'), hlaseni, stat });
  });

  /** příspěvek webu (zveřejněná aktualita nebo akce), který se rozesílá infokanálem */
  async function prispevek(id: unknown) {
    if (!app.obec.moduly.web || typeof id !== 'string' || !id) return null;
    const o = await app.web.obsah.podleId(id);
    if (!o || o.smazano_at || o.stav !== 'zverejneno' || (o.typ !== 'aktualita' && o.typ !== 'akce'))
      return null;
    return o;
  }

  /** předvyplnění hlášení z příspěvku (společné s rozesílkou přes API, viz z-prispevku.ts) */
  const predvyplneni = (
    o: NonNullable<Awaited<ReturnType<typeof prispevek>>>,
    kategorie: { id: number; slug: string }[],
  ) => predvyplneniZPrispevku(app, o, kategorie);

  /** formulář nového hlášení (GET i po chybě) — e-mail a článek v editoru, přílohy, kopírování mezi kanály */
  const formular = (reply: FastifyReply, data: Record<string, unknown>) =>
    reply.view('infokanal/sprava/nove', {
      titulek: t('infokanal.nove_hlaseni'),
      smsPrefix: app.obec.texty.sms_prefix,
      maxPriloh: MAX_PRILOH,
      maxPrilohEmailem: lidskaVelikost(MAX_PRILOH_EMAILEM),
      prilohy: [],
      editor: true,
      ...data,
    });

  app.get<{ Querystring: { obsah?: string } }>(
    '/infokanal/sprava/nove',
    { preHandler: redaktor },
    async (req, reply) => {
      const kategorie = await sluzba.kategorie();
      const o = await prispevek(req.query.obsah);
      const f: Record<string, unknown> = o ? await predvyplneni(o, kategorie) : {};
      // editor e-mailu pracuje s HTML — prostý text z předvyplnění převést na odstavce
      if (typeof f.email_text === 'string') f.email_text = textNaHtml(f.email_text);
      return formular(reply, { kategorie, f, prispevek: o });
    },
  );

  /**
   * přílohy z formuláře: nově nahrané soubory + dříve nahrané (skrytá pole priloha_id, když se formulář vrátil
   * s chybou). Dřív nahraný soubor se přijme jen od téhož uživatele a nejvýš den starý — přes priloha_id tak nejde
   * rozeslat cizí nebo neveřejný soubor z úložiště.
   */
  async function prilohyZFormulare(
    req: FastifyRequest,
    b: Record<string, string | string[] | undefined>,
  ): Promise<{ prilohy: PrilohaHlaseni[]; chyby: string[] }> {
    const chyby: string[] = [];
    const drive = vice(b.priloha_id).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    const odebrat = new Set(vice(b.odebrat_prilohu));
    const zachovat = drive.filter((id) => !odebrat.has(id));
    const radky = zachovat.length
      ? await app.db
          .selectFrom('soubory')
          .select(['id', 'puvodni_nazev', 'velikost', 'mime'])
          .where('id', 'in', zachovat)
          .where('nahral_id', '=', req.uzivatel!.id)
          .where('vytvoren_at', '>', new Date(Date.now() - 24 * 3600_000))
          .execute()
      : [];
    const prilohy: PrilohaHlaseni[] = zachovat
      .map((id) => radky.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ id: r.id, nazev: r.puvodni_nazev, velikost: r.velikost, mime: r.mime }));
    for (const soubor of souboryZPole(req, 'prilohy')) {
      if (prilohy.length >= MAX_PRILOH) {
        chyby.push(t('infokanal.prilohy_max', { n: MAX_PRILOH }));
        break;
      }
      if (soubor.oriznuto) {
        chyby.push(`${soubor.nazev}: ${chybaSouboruText(t, 'velikost')}`);
        continue;
      }
      const v = await app.soubory.uloz({
        data: await fs.readFile(soubor.cesta),
        nazev: soubor.nazev,
        druh: 'dokument',
        nahralId: req.uzivatel!.id,
      });
      if ('chyba' in v) chyby.push(`${soubor.nazev}: ${chybaSouboruText(t, v.chyba)}`);
      else
        prilohy.push({
          id: v.soubor.id,
          nazev: v.soubor.puvodni_nazev,
          velikost: v.soubor.velikost,
          mime: v.soubor.mime,
        });
    }
    return { prilohy, chyby };
  }

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/infokanal/sprava/nove',
    { preHandler: redaktor },
    async (req, reply) => {
      const b = req.body ?? {};
      const kategorie = await sluzba.kategorie();
      // rozesílka příspěvku webu: článek už existuje, nový se nezakládá; hlášení se k příspěvku zapíše
      const o = await prispevek(b.obsah_id);
      if (o) {
        b.clanek_titulek = '';
        b.clanek_text = '';
      }
      const { prilohy, chyby: chybyPriloh } = await prilohyZFormulare(req, b);
      const vykresli = (chyba: string) => formular(reply, { kategorie, f: b, prispevek: o, chyba, prilohy });
      if (chybyPriloh.length) return vykresli(chybyPriloh.join(' '));
      const cilDetail = b.casti === undefined ? [] : Array.isArray(b.casti) ? b.casti : [b.casti];
      const naplanovanoVstup = naplanovanoZFormulare(b.naplanovano_na);
      if (naplanovanoVstup === 'neplatne') return vykresli(t('infokanal.naplanovani_neplatne'));
      const naplanovano = naplanovanoVstup;
      const email = zpracujEmail(String(b.email_text ?? ''), app.env.BASE_URL);
      const v = await sluzba.zalozHlaseni(req.uzivatel!.id, {
        kategorieId: Number(b.kategorie_id),
        krizove: b.krizove === 'ano',
        cil: b.cil === 'casti' ? 'casti' : 'vse',
        cilDetail: cilDetail.filter((c) => app.obec.obec.casti.includes(String(c))).map(String),
        smsText: String(b.sms_text ?? '').trim() || null,
        emailPredmet: String(b.email_predmet ?? '').trim() || null,
        emailText: email.text || null,
        emailHtml: email.html,
        clanekTitulek: String(b.clanek_titulek ?? '').trim() || null,
        clanekHtml: String(b.clanek_text ?? '').trim() || null,
        naplanovanoNa: naplanovano,
        smsJenBezEmailu: b.sms_jen_bez_emailu === 'ano',
        prilohy,
      });
      if ('chyba' in v)
        return vykresli(
          v.chyba === 'sms_dlouha'
            ? t('infokanal.sms_dlouha', { znaku: v.znaku, max: v.max })
            : v.chyba === 'zadny_kanal'
              ? t('infokanal.zadny_kanal')
              : v.chyba === 'zadny_prijemce'
                ? t('infokanal.zadny_prijemce')
                : 'Neplatná kategorie.',
        );
      fronta.kopni();
      if (o) {
        await app.db.updateTable('web_obsah').set({ hlaseni_id: v.id }).where('id', '=', o.id).execute();
        await zapisAudit(app.db, {
          uzivatelId: req.uzivatel!.id,
          akce: 'web.rozeslano',
          detail: { id: o.id, typ: o.typ, hlaseni: v.id, prijemcu: v.prijemcu },
          ip: req.ip,
        });
      }
      // článek z hlášení → aktualita na webu obce (modul web), s datem rozeslání; přílohy pod textem
      const clanekTitulek = String(b.clanek_titulek ?? '').trim();
      if (clanekTitulek && app.obec.moduly.web) {
        const text = String(b.clanek_text ?? '').trim() || String(b.email_text ?? '').trim();
        const html = zpracujClanek(text) + prilohyHtml(prilohy, t('infokanal.prilohy_nadpis'));
        await app.web.obsah.uloz(
          null,
          'aktualita',
          {
            ...PRAZDNA_POLE,
            titulek: clanekTitulek.slice(0, 250),
            perex: zkrat(textZHtml(zpracujClanek(text)), 280),
            obsah_html: html,
            datum: (naplanovano && naplanovano > new Date() ? naplanovano : new Date()).toISOString(),
          },
          'zverejnit',
          req.uzivatel!.id,
          req.ip,
          { zdroj: 'infokanal', hlaseniId: v.id },
        );
      }
      req.session.flash = { typ: 'ok', text: t('infokanal.vytvoreno', { n: v.prijemcu }) };
      return reply.redirect(`/infokanal/sprava/hlaseni/${v.id}`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/infokanal/sprava/hlaseni/:id',
    { preHandler: redaktor },
    async (req, reply) => {
      const h = await sluzba.detailHlaseni(req.params.id).catch(() => null);
      if (!h) return reply.callNotFound();
      return reply.view('infokanal/sprava/detail', {
        titulek: t('infokanal.hlaseni'),
        h,
        segmentu: h.sms_text ? smsSegmenty(app.obec.texty.sms_prefix + h.sms_text) : 0,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/infokanal/sprava/hlaseni/:id/zrusit',
    { preHandler: redaktor },
    async (req, reply) => {
      await sluzba.zrusHlaseni(req.params.id, req.uzivatel!.id);
      req.session.flash = { typ: 'info', text: t('infokanal.stav_zruseno') };
      return reply.redirect(`/infokanal/sprava/hlaseni/${req.params.id}`);
    },
  );

  app.get('/infokanal/sprava/odberatele', { preHandler: redaktor }, async (_req, reply) => {
    const odberatele = await sluzba.seznamOdberatelu();
    const stat = await sluzba.statistiky();
    return reply.view('infokanal/sprava/odberatele', {
      titulek: t('infokanal.odberatele'),
      odberatele,
      stat,
      f: {},
    });
  });

  // přidání odběratele úřadem (např. senior, který přišel osobně) — bez ověřování, zdroj „urad“
  app.post<{ Body: Record<string, string | undefined> }>(
    '/infokanal/sprava/odberatele',
    { preHandler: redaktor },
    async (req, reply) => {
      const b = req.body;
      const telefon = normalizujTelefon(b.telefon);
      const email = String(b.email ?? '').trim() ? normalizujEmail(b.email) : null;
      if (!telefon && !email) {
        req.session.flash = { typ: 'chyba', text: t('infokanal.kontakt_chybi') };
        return reply.redirect('/infokanal/sprava/odberatele');
      }
      const existuje = telefon ? await sluzba.odberatelPodleTelefonu(telefon) : undefined;
      if (existuje && !existuje.odhlasen_at) {
        req.session.flash = { typ: 'chyba', text: t('infokanal.kontakt_duplicitni') };
        return reply.redirect('/infokanal/sprava/odberatele');
      }
      await sluzba.zalozNeboObnov({
        jmeno: String(b.jmeno ?? '')
          .trim()
          .slice(0, 120),
        telefon,
        email,
        castObce: app.obec.obec.casti.includes(String(b.cast_obce)) ? String(b.cast_obce) : '',
        kanal: (['sms', 'smisene', 'email'] as KanalPreference[]).includes(b.kanal as KanalPreference)
          ? (b.kanal as KanalPreference)
          : telefon
            ? 'sms'
            : 'email',
        optouty: [],
        zdroj: 'urad',
        overeno: true,
        souhlas: b.souhlas === 'ano',
      });
      req.session.flash = { typ: 'ok', text: t('infokanal.odberatel_pridan') };
      return reply.redirect('/infokanal/sprava/odberatele');
    },
  );
}
