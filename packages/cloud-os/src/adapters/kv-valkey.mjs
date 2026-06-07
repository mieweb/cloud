/**
 * KV → Valkey/Redis adapter (os.mieweb.org target).
 *
 * Implements the audited KV subset: `get(key, opts)`, `getWithMetadata`,
 * `put(key, value, { expirationTtl, expiration, metadata })`, `delete`, and a
 * prefix `list`. Values live under `<ns>:v:<key>`; optional per-key metadata
 * under `<ns>:m:<key>` (separate namespace so `list` never returns meta keys).
 * TTLs map to Valkey key expiry, so eviction is the server's job.
 *
 * @param {{ url?: string, host?: string, port?: number, namespace?: string }} cfg
 * @returns {Promise<import('@mieweb/cloud-local').LocalKV & { _raw: any, _close: () => Promise<void> }>}
 */
export async function createValkeyKV(cfg) {
  const client = await makeRedis(cfg);
  const ns = cfg.namespace ?? 'kv';
  const vKey = (/** @type {string} */ k) => `${ns}:v:${k}`;
  const mKey = (/** @type {string} */ k) => `${ns}:m:${k}`;

  /** @param {{ expirationTtl?: number, expiration?: number }} [opts] seconds of TTL, or 0 */
  function ttlSeconds(opts) {
    if (opts?.expirationTtl) return Math.max(1, Math.floor(opts.expirationTtl));
    if (opts?.expiration) return Math.max(1, Math.floor(opts.expiration - Date.now() / 1000));
    return 0;
  }

  return {
    /**
     * @param {string} key
     * @param {'text'|'json'|{ type?: 'text'|'json' }} [opts]
     */
    async get(key, opts) {
      const raw = await client.get(vKey(key));
      if (raw === null) return null;
      const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
      return type === 'json' ? JSON.parse(raw) : raw;
    },

    /**
     * @param {string} key
     * @param {'text'|'json'|{ type?: 'text'|'json' }} [opts]
     */
    async getWithMetadata(key, opts) {
      const [raw, meta] = await Promise.all([client.get(vKey(key)), client.get(mKey(key))]);
      if (raw === null) return { value: null, metadata: null };
      const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
      const value = type === 'json' ? JSON.parse(raw) : raw;
      return { value, metadata: meta ? JSON.parse(meta) : null };
    },

    /**
     * @param {string} key
     * @param {string|ArrayBuffer|ArrayBufferView|ReadableStream} value
     * @param {{ expirationTtl?: number, expiration?: number, metadata?: unknown }} [opts]
     */
    async put(key, value, opts) {
      const str =
        typeof value === 'string'
          ? value
          : Buffer.from(/** @type {ArrayBuffer} */ (value)).toString('utf8');
      const ttl = ttlSeconds(opts);
      if (ttl > 0) await client.set(vKey(key), str, 'EX', ttl);
      else await client.set(vKey(key), str);

      if (opts?.metadata != null) {
        const m = JSON.stringify(opts.metadata);
        if (ttl > 0) await client.set(mKey(key), m, 'EX', ttl);
        else await client.set(mKey(key), m);
      } else {
        await client.del(mKey(key));
      }
    },

    /** @param {string} key */
    async delete(key) {
      await client.del(vKey(key), mKey(key));
    },

    /** @param {{ prefix?: string }} [opts] */
    async list(opts) {
      const match = `${ns}:v:${opts?.prefix ?? ''}*`;
      const strip = `${ns}:v:`;
      const keys = [];
      let cursor = '0';
      do {
        // eslint-disable-next-line no-await-in-loop
        const [next, batch] = await client.scan(cursor, 'MATCH', match, 'COUNT', 200);
        cursor = next;
        for (const full of batch) keys.push({ name: full.slice(strip.length) });
      } while (cursor !== '0');
      return { keys, list_complete: true, cacheStatus: null };
    },

    _raw: client,
    async _close() {
      await client.quit();
    },
  };
}

/** @param {{ url?: string, host?: string, port?: number }} cfg */
async function makeRedis(cfg) {
  const Redis = await loadIoredis();
  if (cfg.url) return new Redis(cfg.url, { maxRetriesPerRequest: null });
  return new Redis({
    host: cfg.host ?? '127.0.0.1',
    port: cfg.port ?? 6379,
    maxRetriesPerRequest: null,
  });
}

let _Redis;
async function loadIoredis() {
  if (_Redis) return _Redis;
  try {
    // ioredis ships CJS; the client constructor is the default export.
    _Redis = (await import('ioredis')).default;
    return _Redis;
  } catch {
    throw new Error(
      "The os KV/Queue adapters need 'ioredis'. Install it with " +
        '`pnpm add ioredis` (or choose different KV/Queue drivers).',
    );
  }
}

export { makeRedis, loadIoredis };
