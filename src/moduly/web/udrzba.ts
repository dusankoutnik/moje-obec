// Údržba webu: výchozí položky menu při první instalaci, upozornění správcům na konec povinné publicity dotací.
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { PRAZDNA_POLE } from './obsah.js';

export async function zalozVychoziMenu(app: FastifyInstance) {
  const existuje = await app.db
    .selectFrom('web_obsah')
    .select('id')
    .where('typ', 'in', ['stranka', 'odkaz'])
    .executeTakeFirst();
  if (existuje) return;
  const t = app.t;
  const polozky: [string, string][] = [
    [t('web.menu_aktuality'), '/aktuality'],
    ...(app.obec.moduly.deska ? ([[t('deska.titulek'), '/uredni-deska']] as [string, string][]) : []),
    [t('web.menu_kontakt'), '/kontakt'],
  ];
  for (const [titulek, url] of polozky)
    await app.web.obsah.uloz(null, 'odkaz', { ...PRAZDNA_POLE, titulek, odkaz_url: url }, 'zverejnit', null);
}

export async function upozorniNaKonecDotaci(app: FastifyInstance) {
  const koncici = (await app.web.dotace.koncici(30)).filter((d) => !d.upozorneno_at);
  if (!koncici.length) return 0;
  const spravci = await app.db
    .selectFrom('uzivatele')
    .select(['email'])
    .where('email', 'is not', null)
    .where('blokovan_at', 'is', null)
    .where(sql<boolean>`role && ARRAY['spravce', 'admin']::text[]`)
    .execute();
  const text = app.t('web.dotace_mail_text', {
    seznam: koncici
      .map((d) => `• ${d.projekt} — ${d.zobrazit_do!.split('-').reverse().join('. ')}`)
      .join('\n'),
    odkaz: `${app.env.BASE_URL}/sprava/web/dotace`,
  });
  for (const s of spravci)
    await app.mail
      .posli({ komu: s.email!, predmet: app.t('web.dotace_mail_predmet'), text })
      .catch((e) => app.log.warn({ err: e }, 'mail dotace'));
  await app.web.dotace.oznacUpozorneno(koncici.map((d) => d.id));
  return koncici.length;
}
