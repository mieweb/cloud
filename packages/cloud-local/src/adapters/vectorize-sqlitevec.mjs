import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Vectorize → local SQLite adapter (backed by better-sqlite3 + sqlite-vec).
 *
 * Implements the audited Vectorize subset the app uses:
 *   * `upsert(vectors)`     — insert/replace by id
 *   * `query(values, opts)` — KNN with optional metadata pre-filter
 *   * `deleteByIds(ids)`    — remove by id
 *   * `getByIds(ids)`       — fetch metadata (+ ids) by id
 *
 * Storage mirrors the FOOTNOTE index pattern (github.com/mieweb/melvil-artipod-footnote):
 * a `vec0` virtual table holds the float vectors for cosine KNN, and a sibling
 * metadata table maps each vector `id` to its JSON `metadata` + `namespace`.
 *
 * Vectorize applies metadata filters *before* KNN; sqlite-vec doesn't filter
 * arbitrary metadata inside the KNN scan, so we over-fetch candidates and apply
 * the filter (`$eq/$ne/$in/$nin/$lt/$lte/$gt/$gte` + implicit equality) in JS,
 * then truncate to `topK`. Faithful for local-scale indexes.
 *
 * @param {string} filePath path to the vector .sqlite file (created if missing)
 * @param {{ dim?: number }} [opts] embedding dimension (default 768 = bge-base-en-v1.5)
 * @returns {Promise<import('../index.mjs').LocalVectorIndex>}
 */
export async function createSqliteVecIndex(filePath, opts = {}) {
  const dim = opts.dim ?? 768;
  const { Database, sqliteVec } = await loadDeps();
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);

  // seq = the vec0 rowid; id = the caller's vector id. Metadata kept as JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_meta (
      id        TEXT PRIMARY KEY,
      seq       INTEGER UNIQUE,
      namespace TEXT,
      metadata  TEXT
    );
    CREATE TABLE IF NOT EXISTS vec_seq (next INTEGER NOT NULL);
  `);
  if (!db.prepare('SELECT 1 FROM vec_seq LIMIT 1').get()) {
    db.prepare('INSERT INTO vec_seq (next) VALUES (1)').run();
  }

  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(embedding float[${dim}] distance_metric=cosine);`,
  );

  const nextSeq = () => {
    const row = db.prepare('SELECT next FROM vec_seq LIMIT 1').get();
    const seq = row ? row.next : 1;
    db.prepare('UPDATE vec_seq SET next = ?').run(seq + 1);
    return seq;
  };

  const selSeq = db.prepare('SELECT seq FROM vec_meta WHERE id = ?');
  const delVec = db.prepare('DELETE FROM vec_items WHERE rowid = ?');
  const delMeta = db.prepare('DELETE FROM vec_meta WHERE id = ?');
  const insMeta = db.prepare(
    'INSERT INTO vec_meta (id, seq, namespace, metadata) VALUES (?, ?, ?, ?)',
  );
  // sqlite-vec requires an INTEGER primary key, so rowids must be bound as
  // BigInt (a plain JS number binds as REAL and is rejected).
  const insVec = db.prepare('INSERT INTO vec_items (rowid, embedding) VALUES (?, ?)');

  /** @param {{ id: string, values: number[], metadata?: any, namespace?: string }} v */
  function upsertOne(v) {
    const existing = selSeq.get(v.id);
    if (existing) {
      delVec.run(BigInt(existing.seq));
      delMeta.run(v.id);
    }
    const seq = nextSeq();
    insMeta.run(v.id, seq, v.namespace ?? null, JSON.stringify(v.metadata ?? {}));
    insVec.run(BigInt(seq), JSON.stringify(Array.from(v.values)));
    return seq;
  }

  return {
    /** @param {Array<{ id: string, values: number[], metadata?: any, namespace?: string }>} vectors */
    async upsert(vectors) {
      const list = Array.isArray(vectors) ? vectors : [vectors];
      const tx = db.transaction((vs) => vs.forEach(upsertOne));
      tx(list);
      return { mutationId: randomId(), count: list.length, ids: list.map((v) => v.id) };
    },

    /** @param {Array<{ id: string, values: number[], metadata?: any, namespace?: string }>} vectors */
    async insert(vectors) {
      return this.upsert(vectors);
    },

    /**
     * @param {number[]} values
     * @param {{ topK?: number, returnMetadata?: boolean|'all'|'indexed', returnValues?: boolean, namespace?: string, filter?: Record<string, any> }} [queryOpts]
     */
    async query(values, queryOpts = {}) {
      const topK = queryOpts.topK ?? 5;
      const hasFilter = queryOpts.filter && Object.keys(queryOpts.filter).length > 0;
      const hasNs = typeof queryOpts.namespace === 'string';
      // Over-fetch when we must post-filter so we can still fill topK.
      const scan = hasFilter || hasNs ? Math.min(topK * 20, 2000) : topK;

      const rows = db
        .prepare(
          `SELECT v.rowid AS seq, v.distance AS distance, m.id AS id,
                  m.namespace AS namespace, m.metadata AS metadata
             FROM vec_items v
             JOIN vec_meta m ON m.seq = v.rowid
            WHERE v.embedding MATCH ? AND k = ?
            ORDER BY v.distance`,
        )
        .all(JSON.stringify(Array.from(values)), scan);

      const matches = [];
      for (const r of rows) {
        if (hasNs && r.namespace !== queryOpts.namespace) continue;
        const metadata = r.metadata ? JSON.parse(r.metadata) : {};
        if (hasFilter && !matchesFilter(metadata, queryOpts.filter)) continue;
        const match = { id: r.id, score: 1 - r.distance };
        if (queryOpts.returnMetadata) match.metadata = metadata;
        if (r.namespace != null) match.namespace = r.namespace;
        matches.push(match);
        if (matches.length >= topK) break;
      }
      return { matches, count: matches.length };
    },

    /** @param {string[]} ids */
    async deleteByIds(ids) {
      const tx = db.transaction((list) => {
        for (const id of list) {
          const existing = selSeq.get(id);
          if (existing) delVec.run(BigInt(existing.seq));
          delMeta.run(id);
        }
      });
      tx(ids);
      return { mutationId: randomId(), count: ids.length };
    },

    /** @param {string[]} ids */
    async getByIds(ids) {
      const out = [];
      const sel = db.prepare('SELECT id, namespace, metadata FROM vec_meta WHERE id = ?');
      for (const id of ids) {
        const row = sel.get(id);
        if (row) {
          out.push({
            id: row.id,
            namespace: row.namespace ?? undefined,
            metadata: row.metadata ? JSON.parse(row.metadata) : {},
          });
        }
      }
      return out;
    },

    /** Escape hatch for tooling/tests. */
    _raw: db,
  };
}

/**
 * Apply a Vectorize-style metadata filter to one record's metadata.
 * Supports implicit equality and `$eq/$ne/$in/$nin/$lt/$lte/$gt/$gte`.
 * @param {Record<string, any>} metadata
 * @param {Record<string, any>} filter
 */
function matchesFilter(metadata, filter) {
  for (const [field, cond] of Object.entries(filter)) {
    const value = metadata[field];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (!applyOp(op, value, operand)) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} op
 * @param {any} value
 * @param {any} operand
 */
function applyOp(op, value, operand) {
  switch (op) {
    case '$eq':
      return value === operand;
    case '$ne':
      return value !== operand;
    case '$in':
      return Array.isArray(operand) && operand.includes(value);
    case '$nin':
      return Array.isArray(operand) && !operand.includes(value);
    case '$lt':
      return value < operand;
    case '$lte':
      return value <= operand;
    case '$gt':
      return value > operand;
    case '$gte':
      return value >= operand;
    default:
      // Unknown operator → don't match (fail closed).
      return false;
  }
}

function randomId() {
  return `mut-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Lazily load better-sqlite3 + sqlite-vec so the package installs even where
 * the native modules can't build, and unrelated targets don't pay for them.
 */
async function loadDeps() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    throw new Error(
      "The local Vectorize adapter needs 'better-sqlite3'. Install it with " +
        '`pnpm add -D better-sqlite3` (or choose a different vector driver).',
    );
  }
  let sqliteVec;
  try {
    sqliteVec = await import('sqlite-vec');
  } catch {
    throw new Error(
      "The local Vectorize adapter needs 'sqlite-vec'. Install it with " +
        '`pnpm add -D sqlite-vec` (or choose a different vector driver).',
    );
  }
  return { Database, sqliteVec };
}
