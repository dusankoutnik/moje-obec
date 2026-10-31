// Počet obyvatel na titulce webu, nastavitelný v administraci (dlaždice Aktuality v Obecním webu) správcem obce.
// Pořadí: ruční hodnota z administrace (nastaveni.pocet_obyvatel) → poslední Zpravodaj s evidencí obyvatel
// (API /api/v1/zpravodaj) → obec.yml (obec.fakta s popiskem „obyvatel…“). Prázdné pole ruční hodnotu zruší.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { zapisAudit } from '../../lib/audit.js';
import { vyzadujRoli } from '../ucty/opravneni.js';
import { obyvatelZeZpravodaje } from '../api/zpravodaj.js';

const KLIC = 'pocet_obyvatel';
export const MAX_OBYVATEL = 1_000_000;

export interface RucniObyvatele {
  pocet: number;
  zmeneno_at: string;
}

export async function rucniObyvatele(db: Db): Promise<RucniObyvatele | null> {
  const r = await db.selectFrom('nastaveni').select('hodnota').where('klic', '=', KLIC).executeTakeFirst();
  const h = r?.hodnota as Partial<RucniObyvatele> | undefined;
  return h && Number.isInteger(h.pocet) && h.pocet! > 0
    ? { pocet: h.pocet!, zmeneno_at: String(h.zmeneno_at ?? '') }
    : null;
}

/** hodnota z formuláře: '' = zrušit ruční hodnotu, číslo 1–1 000 000 (mezery jako oddělovač tisíců), jinak chyba */
export function cteniObyvatel(v: unknown): number | null | 'neplatne' {
  const s = String(v ?? '').replace(/\s/g, ''); // \s pokrývá i nezlomitelnou mezeru
  if (!s) return null;
  if (!/^\d{1,7}$/.test(s)) return 'neplatne';
  const n = Number(s);
  return n >= 1 && n <= MAX_OBYVATEL ? n : 'neplatne';
}

/** počet obyvatel z obec.yml (první fakt s popiskem „obyvatel…“), nebo null */
export function obyvateleZProfilu(app: FastifyInstance): number | null {
  const f = app.obec.obec.fakta.find((x) => /obyvatel/i.test(x.popisek));
  return f && /^\d+$/.test(f.hodnota) ? Number(f.hodnota) : null;
}

/** aktuální počet obyvatel podle obce: ruční hodnota z administrace → poslední Zpravodaj → obec.yml; null = nevíme */
export async function aktualniObyvatele(app: FastifyInstance): Promise<number | null> {
  const rucne = await rucniObyvatele(app.db).catch(() => null);
  if (rucne) return rucne.pocet;
  const z = await obyvatelZeZpravodaje(app.db).catch(() => null);
  if (z?.obyvatel) return z.obyvatel;
  return obyvateleZProfilu(app);
}

export default async function obyvateleRoutes(app: FastifyInstance) {
  const spravce = vyzadujRoli('spravce');

  app.post<{ Body: { pocet?: string } }>(
    '/sprava/web/obyvatele',
    { preHandler: spravce },
    async (req, reply) => {
      const t = app.t;
      const n = cteniObyvatel(req.body?.pocet);
      if (n === 'neplatne') {
        req.session.flash = { typ: 'chyba', text: t('web.obyvatele_neplatne', { max: '1 000 000' }) };
        return reply.redirect('/sprava/web#obyvatele');
      }
      const pred = await rucniObyvatele(app.db);
      if (n === null) await app.db.deleteFrom('nastaveni').where('klic', '=', KLIC).execute();
      else {
        const hodnota = JSON.stringify({ pocet: n, zmeneno_at: new Date().toISOString() });
        await app.db
          .insertInto('nastaveni')
          .values({ klic: KLIC, hodnota })
          .onConflict((oc) => oc.column('klic').doUpdateSet({ hodnota, upraven_at: new Date() }))
          .execute();
      }
      await zapisAudit(app.db, {
        uzivatelId: req.uzivatel!.id,
        akce: 'web.obyvatele',
        detail: { pred: pred?.pocet ?? null, po: n },
        ip: req.ip,
      });
      req.session.flash = {
        typ: 'ok',
        text: n === null ? t('web.obyvatele_zruseno') : t('web.obyvatele_ulozeno', { n }),
      };
      return reply.redirect('/sprava/web#obyvatele');
    },
  );
}
