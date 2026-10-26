// Administrace → Systém → Stav systému (administrátor a provozovatel): verze, migrace, SMS brána, e-mail, fronty,
// účty, velikost databáze a zálohy. Jen čtení — nic se neposílá ani nestahuje (stav brány je z poslední kontroly
// plánovače), na stránce nejsou žádná tajemství ani kontakty.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { prehledMigraci } from '../../db/migrate.js';
import { stavMailu } from '../../lib/mail.js';
import { prehledSms } from '../../lib/provoz.js';
import { KLIC_STAVU_BRANY, type StavBrany } from '../infokanal/brana.js';
import { vyzadujRoli } from './opravneni.js';
import { pocetDocasnych } from './role-platnost.js';

const START = new Date();
const KOREN = path.resolve(import.meta.dirname, '..', '..', '..');

function cti(soubor: string): string | null {
  try {
    return readFileSync(path.join(KOREN, soubor), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const VERZE_BALICKU = (() => {
  try {
    return (JSON.parse(cti('package.json') ?? '{}') as { version?: string }).version ?? null;
  } catch {
    return null;
  }
})();

/** po kolika hodinách je poslední záloha „stará“ */
export const ZALOHA_STARA_H = 36;

/** nejnovější soubor v adresáři záloh (a o úroveň níž) — jen název, velikost a čas */
export async function posledniZaloha(adresar: string) {
  const soubory: { nazev: string; velikost: number; at: Date }[] = [];
  const projdi = async (dir: string, hloubka: number) => {
    for (const z of await fs.readdir(dir, { withFileTypes: true })) {
      if (z.name.startsWith('.')) continue;
      const cesta = path.join(dir, z.name);
      if (z.isDirectory() && hloubka < 1) await projdi(cesta, hloubka + 1);
      else if (z.isFile()) {
        const st = await fs.stat(cesta);
        soubory.push({ nazev: path.relative(adresar, cesta), velikost: st.size, at: st.mtime });
      }
    }
  };
  await projdi(adresar, 0);
  soubory.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { pocet: soubory.length, posledni: soubory[0] ?? null };
}

export default async function spravaSystemuRoutes(app: FastifyInstance) {
  app.get('/sprava/system', { preHandler: vyzadujRoli('admin') }, async (_req, reply) => {
    const db = app.db;
    const ted = new Date();

    const migrace = await prehledMigraci(db).catch(() => null);

    const stavBrany = await db
      .selectFrom('nastaveni')
      .select('hodnota')
      .where('klic', '=', KLIC_STAVU_BRANY)
      .executeTakeFirst();
    const brana = (stavBrany?.hodnota as StavBrany | undefined) ?? null;
    const hlidaniBrany =
      !!app.env.SMSGATE_URL &&
      !!app.env.SMSGATE_USER &&
      (app.env.SMS_PROVIDER === 'smsgate' || app.env.SMS_PRESMEROVANI_PROVIDER === 'smsgate');

    const sms = await prehledSms(db, app.env.SMS_DENNI_LIMIT_KODU, false);

    // fronty rozesílky po kanálech: hlášení infokanálu (ik_prijemci) a jednotlivé zprávy aplikací (ik_odchozi)
    const fronty = await sql<{
      zdroj: string;
      kanal: string;
      ceka: number;
      odesila_se: number;
      odeslano: number;
      selhalo: number;
    }>`
      SELECT 'hlaseni' AS zdroj, p.kanal,
             count(*) FILTER (WHERE p.stav = 'ceka')::int AS ceka,
             count(*) FILTER (WHERE p.stav = 'odesila_se')::int AS odesila_se,
             count(*) FILTER (WHERE p.stav IN ('odeslano','doruceno') AND p.odeslano_at > now() - interval '24 hours')::int AS odeslano,
             count(*) FILTER (WHERE p.stav IN ('selhalo','vzdano') AND coalesce(p.zabrano_at, h.vytvoreno_at) > now() - interval '24 hours')::int AS selhalo
        FROM ik_prijemci p JOIN ik_hlaseni h ON h.id = p.hlaseni_id
       WHERE p.stav IN ('ceka','odesila_se') OR coalesce(p.odeslano_at, p.zabrano_at, h.vytvoreno_at) > now() - interval '24 hours'
       GROUP BY p.kanal
      UNION ALL
      SELECT 'aplikace' AS zdroj, o.kanal,
             count(*) FILTER (WHERE o.stav = 'ceka')::int,
             count(*) FILTER (WHERE o.stav = 'odesila_se')::int,
             count(*) FILTER (WHERE o.stav IN ('odeslano','doruceno') AND o.odeslano_at > now() - interval '24 hours')::int,
             count(*) FILTER (WHERE o.stav IN ('selhalo','vzdano') AND o.vytvoreno_at > now() - interval '24 hours')::int
        FROM ik_odchozi o
       WHERE o.stav IN ('ceka','odesila_se') OR coalesce(o.odeslano_at, o.vytvoreno_at) > now() - interval '24 hours'
       GROUP BY o.kanal`
      .execute(db)
      .then((r) => r.rows)
      .catch(() => []);

    const ucty = await sql<{
      celkem: number;
      s_roli: number;
      blokovanych: number;
      sezeni: number;
    }>`
      SELECT (SELECT count(*) FROM uzivatele)::int AS celkem,
             (SELECT count(*) FROM uzivatele WHERE cardinality(role) > 0)::int AS s_roli,
             (SELECT count(*) FROM uzivatele WHERE blokovan_at IS NOT NULL)::int AS blokovanych,
             (SELECT count(*) FROM sezeni WHERE expires_at > now() AND data ? 'uzivatelId')::int AS sezeni`.execute(
      db,
    );

    const velikost = await sql<{ db: string; tabulky: { nazev: string; velikost: string }[] }>`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS db,
             (SELECT coalesce(json_agg(t), '[]'::json) FROM (
                SELECT c.relname AS nazev, pg_size_pretty(pg_total_relation_size(c.oid)) AS velikost
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r'
                 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5) t) AS tabulky`.execute(db);

    let zalohy: {
      nastaveno: boolean;
      chyba?: boolean;
      pocet?: number;
      posledni?: { nazev: string; velikost: number; at: Date } | null;
      stara?: boolean;
    } = { nastaveno: false };
    if (app.env.ZALOHY_DIR) {
      try {
        const z = await posledniZaloha(app.env.ZALOHY_DIR);
        zalohy = {
          nastaveno: true,
          ...z,
          stara: !z.posledni || ted.getTime() - z.posledni.at.getTime() > ZALOHA_STARA_H * 3600_000,
        };
      } catch {
        zalohy = { nastaveno: true, chyba: true };
      }
    }

    return reply.view('sprava/system', {
      titulek: app.t('system.titulek'),
      verze: {
        balicek: VERZE_BALICKU,
        commit: app.env.GIT_COMMIT || null,
        build: cti('build-cas.txt'),
        start: START,
        node: process.version,
        prostredi: app.env.NODE_ENV,
      },
      migrace,
      brana,
      hlidaniBrany,
      smsProvider: app.sms.nazev,
      sms,
      mailProvider: app.mail.nazev,
      mail: stavMailu,
      fronty,
      ucty: { ...ucty.rows[0]!, docasnych: await pocetDocasnych(db) },
      velikost: velikost.rows[0]!,
      zalohy,
      zalohaStaraH: ZALOHA_STARA_H,
      ted,
    });
  });
}
