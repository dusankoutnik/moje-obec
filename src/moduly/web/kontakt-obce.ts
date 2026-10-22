// Kontaktní údaje obecního úřadu editovatelné v administraci (2026-10-23, Dušan: „adresa nebo úřední hodiny se klidně
// mohou změnit“). Výchozí hodnoty jsou v profilu obce (obec.yml); úprava se ukládá do tabulky nastaveni (klíč
// obec_kontakt) a při startu i po uložení se promítne do app.obec — platí tak všude (stránka Kontakt, patička, povinné
// informace, e-maily). IČO, DIČ a bankovní účet zůstávají jen v profilu obce.
import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { zapisAudit } from '../../lib/audit.js';
import { vyzadujRoli } from '../ucty/opravneni.js';

const KLIC = 'obec_kontakt';

export interface KontaktObce {
  ulice: string;
  psc: string;
  mesto: string;
  telefon: string;
  email: string;
  datova_schranka: string;
  uredni_hodiny: string;
}

const POLE: (keyof KontaktObce)[] = [
  'ulice',
  'psc',
  'mesto',
  'telefon',
  'email',
  'datova_schranka',
  'uredni_hodiny',
];
const MAX: Record<keyof KontaktObce, number> = {
  ulice: 120,
  psc: 10,
  mesto: 80,
  telefon: 40,
  email: 120,
  datova_schranka: 20,
  uredni_hodiny: 600,
};

function zProfilu(app: FastifyInstance): KontaktObce {
  const o = app.obec.obec;
  return {
    ulice: o.adresa.ulice ?? '',
    psc: o.adresa.psc ?? '',
    mesto: o.adresa.mesto ?? '',
    telefon: o.kontakt.telefon ?? '',
    email: o.kontakt.email ?? '',
    datova_schranka: o.kontakt.datova_schranka ?? '',
    uredni_hodiny: o.kontakt.uredni_hodiny ?? '',
  };
}

function promitni(app: FastifyInstance, k: KontaktObce) {
  const o = app.obec.obec;
  o.adresa.ulice = k.ulice;
  o.adresa.psc = k.psc;
  o.adresa.mesto = k.mesto;
  o.kontakt.telefon = k.telefon;
  o.kontakt.email = k.email;
  o.kontakt.datova_schranka = k.datova_schranka;
  o.kontakt.uredni_hodiny = k.uredni_hodiny;
}

export function overKontakt(vstup: Record<string, unknown>): { k: KontaktObce; chyby: string[] } {
  const k = {} as KontaktObce;
  const chyby: string[] = [];
  for (const p of POLE) {
    let v = String(vstup[p] ?? '')
      .replace(/\r\n/g, '\n')
      .trim();
    if (p !== 'uredni_hodiny') v = v.replace(/\s+/g, ' ');
    else
      v = v
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean)
        .join('\n');
    if (v.length > MAX[p]) chyby.push(p);
    k[p] = v.slice(0, MAX[p]);
  }
  if (!k.ulice || !k.mesto) chyby.push('adresa');
  if (k.psc && !/^\d{3} ?\d{2}$/.test(k.psc)) chyby.push('psc');
  if (k.email && !/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(k.email)) chyby.push('email');
  if (k.telefon && !/^[+\d][\d \-/()]{5,}$/.test(k.telefon)) chyby.push('telefon');
  return { k, chyby };
}

async function kontaktObce(app: FastifyInstance) {
  const vychozi = zProfilu(app); // profil obce z obec.yml (před úpravami)
  const db = app.db;

  const nacti = async (): Promise<KontaktObce | null> => {
    const r = await db.selectFrom('nastaveni').select('hodnota').where('klic', '=', KLIC).executeTakeFirst();
    return r ? ({ ...vychozi, ...(r.hodnota as unknown as Partial<KontaktObce>) } as KontaktObce) : null;
  };
  const ulozena = await nacti().catch(() => null);
  if (ulozena) promitni(app, ulozena);

  const redaktor = vyzadujRoli('web');
  const vykresli = (reply: FastifyReply, data: Record<string, unknown>) =>
    reply.view('web/sprava/kontakt', { titulek: app.t('web.kontakt_obce'), vychozi, ...data });

  app.get('/sprava/web/kontakt', { preHandler: redaktor }, async (req, reply) =>
    vykresli(reply, { f: zProfilu(app), upraveno: !!(await nacti()), chyby: [] }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/sprava/web/kontakt',
    { preHandler: redaktor },
    async (req, reply) => {
      const { k, chyby } = overKontakt(req.body ?? {});
      if (chyby.length) return vykresli(reply, { f: k, upraveno: !!(await nacti()), chyby });
      const pred = zProfilu(app);
      await db
        .insertInto('nastaveni')
        .values({ klic: KLIC, hodnota: JSON.stringify(k) })
        .onConflict((oc) =>
          oc.column('klic').doUpdateSet({ hodnota: JSON.stringify(k), upraven_at: new Date() }),
        )
        .execute();
      promitni(app, k);
      await zapisAudit(db, {
        uzivatelId: req.uzivatel?.id ?? null,
        akce: 'web.kontakt_obce',
        detail: { pred, po: k },
        ip: req.ip,
      });
      req.session.flash = { typ: 'ok', text: app.t('web.kontakt_obce_ulozeno') };
      return reply.redirect('/sprava/web/kontakt');
    },
  );

  app.post('/sprava/web/kontakt/vychozi', { preHandler: redaktor }, async (req, reply) => {
    const pred = zProfilu(app);
    await db.deleteFrom('nastaveni').where('klic', '=', KLIC).execute();
    promitni(app, vychozi);
    await zapisAudit(db, {
      uzivatelId: req.uzivatel?.id ?? null,
      akce: 'web.kontakt_obce_vychozi',
      detail: { pred },
      ip: req.ip,
    });
    req.session.flash = { typ: 'ok', text: app.t('web.kontakt_obce_vychozi_hotovo') };
    return reply.redirect('/sprava/web/kontakt');
  });
}

export default fp(kontaktObce, { name: 'web-kontakt-obce' });
