// Připojení k Postgresu přes Kysely. Jeden pool na proces; typy v ./types.ts.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// sloupce typu date vracet jako text 'YYYY-MM-DD' (ne Date o půlnoci v časové zóně serveru)
pg.types.setTypeParser(1082, (v: string) => v);
import type { Database } from './types.js';

export type Db = Kysely<Database>;

export function vytvorDb(connectionString: string, maxPool = 8): Db {
  const pool = new pg.Pool({ connectionString, max: maxPool });
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
