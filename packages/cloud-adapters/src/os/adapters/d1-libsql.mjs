/**
 * D1 → libSQL/sqld adapter (os.mieweb.org target).
 *
 * libSQL is a SQLite fork with a server mode, so the application's SQL —
 * including the FTS5 search migrations — runs unchanged; only the transport
 * differs. The Cloudflare D1 wire API is already async, which maps cleanly
 * onto `@libsql/client`'s promise-based `execute`/`batch`.
 *
 * Implements the audited D1 subset: `prepare().bind().first()/.all()/.run()/
 * .raw()`, `batch()` (atomic), and `exec()`.
 *
 * @param {{ url: string, authToken?: string }} cfg
 * @returns {Promise<import('@mieweb/cloud-local').LocalD1>}
 */
export async function createLibsqlD1(cfg) {
  const { createClient } = await loadLibsql();
  const client = createClient({ url: cfg.url, authToken: cfg.authToken });

  /** @param {string} sql */
  function prepare(sql) {
    /** @type {unknown[]} */
    let bound = [];

    const stmt = {
      /** @param {...unknown} args */
      bind(...args) {
        bound = args;
        return stmt;
      },
      /** @param {string} [column] */
      async first(column) {
        const res = await client.execute({ sql, args: toArgs(bound) });
        const row = res.rows[0];
        if (row === undefined) return null;
        const obj = rowToObject(row, res.columns);
        if (column !== undefined) return obj[column] ?? null;
        return obj;
      },
      async all() {
        const res = await client.execute({ sql, args: toArgs(bound) });
        return {
          results: res.rows.map((r) => rowToObject(r, res.columns)),
          success: true,
          meta: metaFrom(res),
        };
      },
      async run() {
        const res = await client.execute({ sql, args: toArgs(bound) });
        return { results: [], success: true, meta: metaFrom(res) };
      },
      async raw() {
        const res = await client.execute({ sql, args: toArgs(bound) });
        return res.rows.map((r) => res.columns.map((_, i) => r[i]));
      },
      // Internal: lets batch() capture the SQL + args for one transaction.
      _toStmt() {
        return { sql, args: toArgs(bound) };
      },
    };
    return stmt;
  }

  return {
    prepare,
    /** @param {ReturnType<typeof prepare>[]} statements */
    async batch(statements) {
      const results = await client.batch(
        statements.map((st) => st._toStmt()),
        'write',
      );
      return results.map((res) => ({
        results: res.rows.map((r) => rowToObject(r, res.columns)),
        success: true,
        meta: metaFrom(res),
      }));
    },
    /** @param {string} sql */
    async exec(sql) {
      // executeMultiple runs several `;`-separated statements (migrations).
      await client.executeMultiple(sql);
      return { count: 0, duration: 0 };
    },
    /** Escape hatch for tooling/tests. */
    _raw: client,
  };
}

/**
 * libSQL rows are array-indexable and also expose column-name keys; normalize
 * to a plain object keyed by column name to exactly match D1's shape.
 * @param {any} row
 * @param {string[]} columns
 */
function rowToObject(row, columns) {
  /** @type {Record<string, unknown>} */
  const obj = {};
  columns.forEach((col, i) => {
    obj[col] = row[i];
  });
  return obj;
}

/** @param {{ rowsAffected: number, lastInsertRowid?: bigint }} res */
function metaFrom(res) {
  const changes = res.rowsAffected ?? 0;
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    changes,
    last_row_id: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : 0,
    changed_db: changes > 0,
  };
}

/**
 * libSQL accepts positional args as an array; `undefined` is not a valid bind
 * value, so coerce it to null (matching SQLite's NULL).
 * @param {unknown[]} args
 */
function toArgs(args) {
  return args.map((a) => (a === undefined ? null : a));
}

async function loadLibsql() {
  try {
    return await import('@libsql/client');
  } catch {
    throw new Error(
      "The os D1 adapter needs '@libsql/client'. Install it with " +
        '`pnpm add @libsql/client` (or choose a different D1 driver).',
    );
  }
}
