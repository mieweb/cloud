import { matchesFilter } from '@mieweb/cloud-local';

/**
 * Vectorize → libSQL native vectors (os.mieweb.org target).
 *
 * Uses libSQL's built-in vector support (`F32_BLOB` columns, `vector32()`,
 * `vector_distance_cos()`) so the vector index lives in the same libSQL server
 * as D1 — one fewer moving part. Implements the same audited Vectorize subset
 * as the local sqlite-vec adapter (upsert/query/deleteByIds/getByIds) and
 * reuses the shared metadata-filter semantics.
 *
 * KNN is a brute-force `ORDER BY vector_distance_cos` scan with over-fetch +
 * JS metadata filtering — faithful and index-free at os scale. (A
 * `libsql_vector_idx` ANN index can be added later behind the same contract.)
 *
 * @param {{ url: string, authToken?: string, dim?: number, table?: string }} cfg
 * @returns {Promise<import('@mieweb/cloud-local').LocalVectorIndex>}
 */
export async function createLibsqlVecIndex(cfg) {
  const { createClient } = await loadLibsql();
  const client = createClient({ url: cfg.url, authToken: cfg.authToken });
  const dim = cfg.dim ?? 768;
  const table = cfg.table ?? 'vec_items';

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id        TEXT PRIMARY KEY,
       embedding F32_BLOB(${dim}),
       namespace TEXT,
       metadata  TEXT
     )`,
  );

  /** @param {{ id: string, values: number[], metadata?: any, namespace?: string }} v */
  function upsertStmt(v) {
    return {
      sql: `INSERT INTO ${table} (id, embedding, namespace, metadata)
            VALUES (?, vector32(?), ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              embedding = excluded.embedding,
              namespace = excluded.namespace,
              metadata  = excluded.metadata`,
      args: [
        v.id,
        JSON.stringify(Array.from(v.values)),
        v.namespace ?? null,
        JSON.stringify(v.metadata ?? {}),
      ],
    };
  }

  return {
    /** @param {Array<{ id: string, values: number[], metadata?: any, namespace?: string }>} vectors */
    async upsert(vectors) {
      const list = Array.isArray(vectors) ? vectors : [vectors];
      if (list.length) await client.batch(list.map(upsertStmt), 'write');
      return { mutationId: randomId(), count: list.length, ids: list.map((v) => v.id) };
    },

    /** @param {Array<{ id: string, values: number[], metadata?: any, namespace?: string }>} vectors */
    async insert(vectors) {
      return this.upsert(vectors);
    },

    /**
     * @param {number[]} values
     * @param {{ topK?: number, returnMetadata?: boolean|'all'|'indexed', namespace?: string, filter?: Record<string, any> }} [queryOpts]
     */
    async query(values, queryOpts = {}) {
      const topK = queryOpts.topK ?? 5;
      const hasFilter = queryOpts.filter && Object.keys(queryOpts.filter).length > 0;
      const hasNs = typeof queryOpts.namespace === 'string';
      const scan = hasFilter || hasNs ? Math.min(topK * 20, 2000) : topK;

      const res = await client.execute({
        sql: `SELECT id, namespace, metadata,
                     vector_distance_cos(embedding, vector32(?)) AS distance
                FROM ${table}
               ORDER BY distance
               LIMIT ?`,
        args: [JSON.stringify(Array.from(values)), scan],
      });

      const matches = [];
      for (const row of res.rows) {
        const namespace = row.namespace ?? null;
        if (hasNs && namespace !== queryOpts.namespace) continue;
        const metadata = row.metadata ? JSON.parse(String(row.metadata)) : {};
        if (hasFilter && !matchesFilter(metadata, queryOpts.filter)) continue;
        const match = { id: String(row.id), score: 1 - Number(row.distance) };
        if (queryOpts.returnMetadata) match.metadata = metadata;
        if (namespace != null) match.namespace = namespace;
        matches.push(match);
        if (matches.length >= topK) break;
      }
      return { matches, count: matches.length };
    },

    /** @param {string[]} ids */
    async deleteByIds(ids) {
      if (ids.length) {
        await client.batch(
          ids.map((id) => ({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] })),
          'write',
        );
      }
      return { mutationId: randomId(), count: ids.length };
    },

    /** @param {string[]} ids */
    async getByIds(ids) {
      const out = [];
      for (const id of ids) {
        const res = await client.execute({
          sql: `SELECT id, namespace, metadata FROM ${table} WHERE id = ?`,
          args: [id],
        });
        const row = res.rows[0];
        if (row) {
          out.push({
            id: String(row.id),
            namespace: row.namespace ?? undefined,
            metadata: row.metadata ? JSON.parse(String(row.metadata)) : {},
          });
        }
      }
      return out;
    },

    /** Escape hatch for tooling/tests. */
    _raw: client,
  };
}

function randomId() {
  return `mut-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

async function loadLibsql() {
  try {
    return await import('@libsql/client');
  } catch {
    throw new Error(
      "The os Vectorize adapter needs '@libsql/client'. Install it with " +
        '`pnpm add @libsql/client` (or choose a different vector driver).',
    );
  }
}
