import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * D1 → local SQLite adapter (backed by better-sqlite3).
 *
 * Implements the subset of the Cloudflare D1 API the application actually
 * uses (audited): `prepare().bind().first()/.all()/.run()/.raw()`, `batch()`,
 * and `exec()`. D1's wire API is async; better-sqlite3 is synchronous, so we
 * wrap every call in a resolved promise to preserve the awaited shape.
 *
 * SQLite's own FTS5 (used by the search index) works out of the box with the
 * standard better-sqlite3 build, so the FTS5 migrations apply unchanged.
 *
 * @param {string} filePath path to the .sqlite file (created if missing)
 * @returns {Promise<import('../index.mjs').LocalD1>}
 */
export async function createSqliteD1(filePath) {
  const Database = await loadBetterSqlite();
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  /** @param {string} sql */
  function prepare(sql) {
    /** @type {unknown[]} */
    let bound = [];

    // Synchronous primitives the async methods (and batch) build on.
    const runSync = () => {
      const info = db.prepare(sql).run(...bound);
      return {
        results: [],
        success: true,
        meta: {
          ...emptyMeta(),
          changes: info.changes,
          last_row_id: Number(info.lastInsertRowid),
          rows_written: info.changes,
        },
      };
    };
    const allSync = () => ({
      results: db.prepare(sql).all(...bound),
      success: true,
      meta: emptyMeta(),
    });

    const stmt = {
      /** @param {...unknown} args */
      bind(...args) {
        bound = args;
        return stmt;
      },
      /** @param {string} [column] */
      async first(column) {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          db.prepare(sql).get(...bound)
        );
        if (row === undefined) return null;
        if (column !== undefined) return row[column] ?? null;
        return row;
      },
      async all() {
        return allSync();
      },
      async run() {
        return runSync();
      },
      async raw() {
        return db.prepare(sql).raw().all(...bound);
      },
      // Internal: used by batch() to execute inside one sync transaction.
      _allSync: allSync,
    };
    return stmt;
  }

  return {
    prepare,
    /** @param {ReturnType<typeof prepare>[]} statements */
    async batch(statements) {
      // D1 runs a batch atomically; better-sqlite3 transactions are sync, so
      // we execute every captured statement inside a single transaction.
      const tx = db.transaction((stmts) => stmts.map((st) => st._allSync()));
      return tx(statements);
    },
    /** @param {string} sql */
    async exec(sql) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    /** Escape hatch for the migration runner / tooling. */
    _raw: db,
  };
}

function emptyMeta() {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    changes: 0,
    last_row_id: 0,
    changed_db: false,
  };
}

/**
 * Lazily load better-sqlite3 so the package installs even where the native
 * module can't build, and so unrelated targets don't pay for it.
 */
async function loadBetterSqlite() {
  try {
    const mod = await import('better-sqlite3');
    return mod.default;
  } catch {
    throw new Error(
      "The local D1 adapter needs 'better-sqlite3'. Install it with " +
        '`pnpm add -D better-sqlite3` (or choose a different D1 driver).',
    );
  }
}
