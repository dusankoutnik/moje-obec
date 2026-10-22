// Rozesílka příspěvku webu infokanálem: předvyplnění hlášení (správa → „Rozeslat infokanálem“) a rozeslání bez
// formuláře (API /api/v1/prispevky/:id/rozeslat). Stejné texty v obou cestách.
import type { FastifyInstance } from 'fastify';
import type { WebObsah } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { textZHtml, zkrat } from '../../lib/html.js';
import { bezDiakritiky } from '../../lib/kontakty.js';
import { formatujDatum } from '../../web/sablony.js';

/** předvyplnění hlášení z příspěvku: předmět = titulek, e-mail = perex + odkaz, SMS krátce + odkaz (1 SMS) */
export async function predvyplneniZPrispevku(
  app: FastifyInstance,
  o: WebObsah,
  kategorie: { id: number; slug: string }[],
) {
  const t = app.t;
  const url = `${app.env.BASE_URL}${await app.web.obsah.url(o)}`;
  const kdy = o.typ === 'akce' && o.datum ? formatujDatum(o.datum, !o.akce_cely_den) : '';
  // akce → pozvánky (kultura), jinak obecná hlášení — jen kategorie, které v infokanálu existují
  const slugy = o.typ === 'akce' ? ['pozvanky', 'kultura', 'hlaseni'] : ['hlaseni'];
  const k = slugy.map((sl) => kategorie.find((x) => x.slug === sl)).find(Boolean) ?? kategorie[0];
  const uvod = o.typ === 'akce' ? t('propojeni.sms_pozvanka') : '';
  const prefix = app.obec.texty.sms_prefix;
  const misto = 160 - bezDiakritiky(prefix).length - url.length - 1;
  const zaklad = bezDiakritiky(
    `${uvod}${o.titulek}${kdy ? `, ${kdy}` : ''}${o.akce_misto && o.typ === 'akce' ? `, ${o.akce_misto}` : ''}`,
  );
  const sms = bezDiakritiky(`${zkrat(zaklad, Math.max(30, misto - 2))} ${url}`); // „…“ → „...“
  const perex = o.perex || zkrat(textZHtml(o.obsah_html), 400);
  return {
    kategorie_id: String(k?.id ?? ''),
    email_predmet: (o.typ === 'akce'
      ? t('propojeni.email_pozvanka', { titulek: o.titulek })
      : o.titulek
    ).slice(0, 200),
    email_text: [
      kdy ? `${t('web.kdy')}: ${kdy}${o.akce_misto ? `, ${o.akce_misto}` : ''}` : '',
      perex,
      `${t('propojeni.email_odkaz')} ${url}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    sms_text: sms,
    obsah_id: o.id,
  };
}

export type VysledekRozeslani =
  | { id: string; prijemcu: number }
  | { chyba: 'neni_zverejneno' | 'zadny_kanal' | 'zadny_prijemce' | 'kategorie' | 'sms_dlouha' };

/** rozešle zveřejněnou aktualitu/akci hned (e-mail; SMS jen když `sms`); hlášení se zapíše k příspěvku */
export async function rozesliPrispevek(
  app: FastifyInstance,
  o: WebObsah,
  v: { aktorId: string | null; ip?: string | null; sms: boolean; kategorieSlug?: string; zdroj?: string },
): Promise<VysledekRozeslani> {
  if (o.smazano_at || o.stav !== 'zverejneno' || (o.typ !== 'aktualita' && o.typ !== 'akce'))
    return { chyba: 'neni_zverejneno' };
  const kategorie = await app.infokanal.kategorie();
  const f = await predvyplneniZPrispevku(app, o, kategorie);
  const vlastni = v.kategorieSlug ? kategorie.find((k) => k.slug === v.kategorieSlug) : undefined;
  if (v.kategorieSlug && !vlastni) return { chyba: 'kategorie' };
  const r = await app.infokanal.zalozHlaseni(v.aktorId, {
    kategorieId: vlastni?.id ?? Number(f.kategorie_id),
    krizove: false,
    cil: 'vse',
    cilDetail: [],
    smsText: v.sms ? f.sms_text : null,
    emailPredmet: f.email_predmet,
    emailText: f.email_text,
  });
  if ('chyba' in r) return { chyba: r.chyba };
  app.infokanalFronta.kopni();
  await app.db.updateTable('web_obsah').set({ hlaseni_id: r.id }).where('id', '=', o.id).execute();
  await zapisAudit(app.db, {
    uzivatelId: v.aktorId,
    akce: 'web.rozeslano',
    detail: {
      id: o.id,
      typ: o.typ,
      hlaseni: r.id,
      prijemcu: r.prijemcu,
      ...(v.zdroj ? { zdroj: v.zdroj } : {}),
    },
    ip: v.ip,
  });
  return r;
}
