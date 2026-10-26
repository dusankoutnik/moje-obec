// Migrace schématu — Kysely Migrator nad soubory v ./migrations (pořadí podle názvu).
// Spouští se při startu aplikace i ručně: `npm run migrate`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely';
import type { Db } from './index.js';

function migrator(db: Db) {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  });
}

/** přehled migrací pro stránku Stav systému: kolik jich je, kolik je provedených, poslední a chybějící */
export async function prehledMigraci(db: Db) {
  const vse = await migrator(db).getMigrations();
  const provedene = vse.filter((m) => m.executedAt);
  const posledni = provedene.at(-1) ?? null;
  return {
    celkem: vse.length,
    provedeno: provedene.length,
    posledni: posledni ? { nazev: posledni.name, at: posledni.executedAt! } : null,
    chybi: vse.filter((m) => !m.executedAt).map((m) => m.name),
  };
}

export async function migruj(
  db: Db,
  log?: { info: (o: unknown, msg?: string) => void; error?: (o: unknown, msg?: string) => void },
): Promise<void> {
  const { error, results } = await migrator(db).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Success') log?.info({ migrace: r.migrationName }, 'migrace provedena');
    else if (r.status === 'Error') {
      const o = { migrace: r.migrationName, err: error };
      if (log?.error) log.error(o, 'migrace SELHALA');
      else log?.info(o, 'migrace SELHALA');
    }
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
  await migruj(db, {
    info: (o, m) => console.log(m, JSON.stringify(o)),
    error: (o, m) => console.error(m, JSON.stringify(o)),
  });
  await db.destroy();
  console.log('Migrace hotovy.');
}
