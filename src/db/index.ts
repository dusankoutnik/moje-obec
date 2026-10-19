// Připojení k Postgresu přes Kysely. Jeden pool na proces; typy v ./types.ts.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// sloupce typu date vracet jako text 'YYYY-MM-DD' (ne Date o půlnoci v časové zóně serveru)
pg.types.setTypeParser(1082, (v: string) => v);
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export interface VolbyDb {
  /** jak dlouho čekat na spojení z poolu / na připojení k serveru (ms) */
  connectionTimeoutMillis?: number;
  /** nejdelší dotaz (ms); 0 = bez limitu (migrace a importy si ho mohou vypnout) */
  statementTimeoutMs?: number;
  /** kam hlásit chyby nečinných spojení (restart Postgresu) — jinak by shodily proces */
  priChybe?: (e: Error) => void;
}

export function vytvorDb(connectionString: string, maxPool = 8, volby: VolbyDb = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: maxPool,
    connectionTimeoutMillis: volby.connectionTimeoutMillis ?? 10_000,
    statement_timeout: volby.statementTimeoutMs ?? 30_000,
  });
  // nečinné spojení, které spadne (restart/výpadek Postgresu), vyvolá na poolu 'error' — bez posluchače by to
  // byla neošetřená výjimka a pád celé aplikace; pool spojení zahodí a příště otevře nové
  pool.on('error', (e) =>
    (volby.priChybe ?? ((x) => console.error('Postgres: chyba nečinného spojení', x)))(e),
  );
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

// Postgres v compose může startovat déle než aplikace — chvíli počkáme, místo abychom spadli.
export async function pockejNaDb(db: Db, pokusu = 30, prodlevaMs = 1000): Promise<void> {
  let posledni: unknown;
  for (let i = 0; i < pokusu; i++) {
    try {
      await db.selectNoFrom((eb) => eb.val(1).as('x')).execute();
      return;
    } catch (e) {
      posledni = e;
      await new Promise((r) => setTimeout(r, prodlevaMs));
    }
  }
  throw new Error(`Databáze neodpovídá: ${(posledni as Error)?.message}`);
}
