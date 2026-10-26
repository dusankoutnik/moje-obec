// Úložiště sezení pro @fastify/session v Postgresu (tabulka sezeni) — odhlášení = smazání řádku, žádné „visící“ cookie.
import type { SessionStore } from '@fastify/session';
import type { Session } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { zkratProhlizec } from '../lib/prohlizec.js';

type CbSet = Parameters<SessionStore['set']>[2];
type CbGet = Parameters<SessionStore['get']>[1];
type CbDestroy = Parameters<SessionStore['destroy']>[1];

const VYCHOZI_PLATNOST_MS = 30 * 24 * 3600_000;

export class PostgresSessionStore implements SessionStore {
  constructor(private db: Db) {}

  set(sid: string, session: Session, cb: CbSet) {
    const exp = (session as unknown as { cookie?: { expires?: Date | string | null } }).cookie?.expires;
    const expires = exp ? new Date(exp) : new Date(Date.now() + VYCHOZI_PLATNOST_MS);
    this.db
      .insertInto('sezeni')
      .values({ sid, data: JSON.stringify(session), expires_at: expires })
      .onConflict((oc) =>
        oc.column('sid').doUpdateSet({ data: JSON.stringify(session), expires_at: expires }),
      )
      .execute()
      .then(() => cb())
      .catch(cb);
  }

  get(sid: string, cb: CbGet) {
    this.db
      .selectFrom('sezeni')
      .select(['data', 'expires_at'])
      .where('sid', '=', sid)
      .executeTakeFirst()
      .then((r) => {
        if (!r || r.expires_at < new Date()) return cb(null, null);
        cb(null, r.data as unknown as Session);
      })
      .catch(cb);
  }

  destroy(sid: string, cb: CbDestroy) {
    this.db
      .deleteFrom('sezeni')
      .where('sid', '=', sid)
      .execute()
      .then(() => cb())
      .catch(cb);
  }

  // úklid prošlých sezení (cron)
  async uklid(): Promise<void> {
    await this.db.deleteFrom('sezeni').where('expires_at', '<', new Date()).execute();
  }
}

// Poslední aktivita sezení pro přehled přihlášených zařízení: zapisuje se nejvýš jednou za AKTIVITA_MIN minut
// (paměť procesu + podmínka v SQL), spolu se zkráceným popisem prohlížeče při prvním zápisu.
const AKTIVITA_MIN = 5;
const naposledy = new Map<string, number>();

export async function zaznamenejAktivitu(db: Db, sid: string | undefined, ua: string | undefined) {
  if (!sid) return;
  const ted = Date.now();
  const posledni = naposledy.get(sid);
  if (posledni && ted - posledni < AKTIVITA_MIN * 60_000) return;
  if (naposledy.size > 10_000) naposledy.clear();
  naposledy.set(sid, ted);
  await db
    .updateTable('sezeni')
    .set({
      aktivita_at: new Date(ted),
      prohlizec: sql<string | null>`coalesce(prohlizec, ${zkratProhlizec(ua)})`,
    })
    .where('sid', '=', sid)
    .where((eb) =>
      eb.or([eb('aktivita_at', 'is', null), eb('aktivita_at', '<', new Date(ted - AKTIVITA_MIN * 60_000))]),
    )
    .execute();
}
