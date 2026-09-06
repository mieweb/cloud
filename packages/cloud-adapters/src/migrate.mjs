import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSqliteD1 } from './adapters/d1-sqlite.mjs';

/**
 * Apply the repo's `migrations/*.sql` to a local SQLite database, in filename
 * order, recording applied filenames in a `d1_migrations` table so re-runs are
 * idempotent (mirroring wrangler's behavior closely enough for local dev).
 *
 * This is what `mieweb d1 migrations apply <db> --target local` calls.
 *
 * @param {{ dbPath: string, migrationsDir: string }} opts
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function applyMigrations({ dbPath, migrationsDir }) {
  const d1 = await createSqliteD1(dbPath);
  const db = d1._raw;

  db.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );

  const done = new Set(
    db
      .prepare('SELECT name FROM d1_migrations')
      .all()
      .map((/** @type {{ name: string }} */ r) => r.name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const skipped = [];

  const insert = db.prepare('INSERT INTO d1_migrations (name) VALUES (?)');

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insert.run(file);
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}
