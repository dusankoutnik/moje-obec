// Správa infokanálu úřadem: hlášení (seznam, nové, detail, zastavení), odběratelé (seznam, přidání úřadem).
import type { FastifyInstance } from 'fastify';
import type { KanalPreference } from '../../db/types.js';
import { normalizujEmail, normalizujTelefon, smsSegmenty } from '../../lib/kontakty.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { sanitizuj, textNaHtml, textZHtml, zkrat } from '../../lib/html.js';
import { PRAZDNA_POLE } from '../web/obsah.js';
import type { InfokanalSluzba } from './sluzba.js';
import { casPraha } from '../../lib/datum.js';

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

  app.get('/infokanal/sprava/nove', { preHandler: redaktor }, async (_req, reply) => {
    const kategorie = await sluzba.kategorie();
    return reply.view('infokanal/sprava/nove', {
      titulek: t('infokanal.nove_hlaseni'),
      kategorie,
      f: {},
      smsPrefix: app.obec.texty.sms_prefix,
    });
  });

  app.post<{ Body: Record<string, string | string[] | undefined> }>(
    '/infokanal/sprava/nove',
    { preHandler: redaktor },
    async (req, reply) => {
      const b = req.body;
      const kategorie = await sluzba.kategorie();
      const vykresli = (chyba: string) =>
        reply.view('infokanal/sprava/nove', {
          titulek: t('infokanal.nove_hlaseni'),
          kategorie,
          f: b,
          chyba,
          smsPrefix: app.obec.texty.sms_prefix,
        });
      const cilDetail = b.casti === undefined ? [] : Array.isArray(b.casti) ? b.casti : [b.casti];
      const naplanovanoVstup = naplanovanoZFormulare(b.naplanovano_na);
      if (naplanovanoVstup === 'neplatne') return vykresli(t('infokanal.naplanovani_neplatne'));
      const naplanovano = naplanovanoVstup;
      const v = await sluzba.zalozHlaseni(req.uzivatel!.id, {
        kategorieId: Number(b.kategorie_id),
        krizove: b.krizove === 'ano',
        cil: b.cil === 'casti' ? 'casti' : 'vse',
        cilDetail: cilDetail.filter((c) => app.obec.obec.casti.includes(String(c))).map(String),
        smsText: String(b.sms_text ?? '').trim() || null,
        emailPredmet: String(b.email_predmet ?? '').trim() || null,
        emailText: String(b.email_text ?? '').trim() || null,
        clanekTitulek: String(b.clanek_titulek ?? '').trim() || null,
        clanekHtml: String(b.clanek_text ?? '').trim() || null,
        naplanovanoNa: naplanovano,
        smsJenBezEmailu: b.sms_jen_bez_emailu === 'ano',
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
      // článek z hlášení → aktualita na webu obce (modul web), s datem rozeslání
      const clanekTitulek = String(b.clanek_titulek ?? '').trim();
      if (clanekTitulek && app.obec.moduly.web) {
        const text = String(b.clanek_text ?? '').trim() || String(b.email_text ?? '').trim();
        const html = /<[a-z][\s\S]*>/i.test(text) ? sanitizuj(text) : textNaHtml(text);
        await app.web.obsah.uloz(
          null,
          'aktualita',
          {
            ...PRAZDNA_POLE,
            titulek: clanekTitulek.slice(0, 250),
            perex: zkrat(textZHtml(html), 280),
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
