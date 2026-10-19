// Migrace schématu — Kysely Migrator nad soubory v ./migrations (pořadí podle názvu).
// Spouští se při startu aplikace i ručně: `npm run migrate`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
import type { Db } from './index.js';

export async function migruj(db: Db, log?: { info: (o: unknown, msg?: string) => void }): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Success') log?.info({ migrace: r.migrationName }, 'migrace provedena');
    else if (r.status === 'Error') log?.info({ migrace: r.migrationName }, 'migrace SELHALA');
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

// ruční spuštění: tsx src/db/migrate.ts
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { nactiEnv } = await import('../config/env.js');
  const { vytvorDb, pockejNaDb } = await import('./index.js');
  const env = nactiEnv();
  const db = vytvorDb(env.DATABASE_URL, 2, { statementTimeoutMs: 0 }); // migrace (indexy) smí běžet déle
  await pockejNaDb(db);
  await migruj(db, { info: (o, m) => console.log(m, JSON.stringify(o)) });
  await db.destroy();
  console.log('Migrace hotovy.');
}
