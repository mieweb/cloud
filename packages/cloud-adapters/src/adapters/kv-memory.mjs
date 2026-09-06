/**
 * KV → in-memory adapter (with optional TTL expiry).
 *
 * Implements the audited KV subset: `get(key, opts)`, `put(key, value, opts)`
 * with `expirationTtl`, plus `delete` and a basic `list`. Values are stored as
 * strings (matching KV's default). This is process-local and non-persistent —
 * exactly the semantics a read-through cache (the app's only KV use) expects
 * in local dev. Swap for Redis by implementing the same shape.
 *
 * @returns {import('../index.mjs').LocalKV}
 */
export function createMemoryKV() {
  /** @type {Map<string, { value: string, expiresAt: number|null, metadata: unknown }>} */
  const store = new Map();

  /** @param {string} key */
  function live(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  return {
    /**
     * @param {string} key
     * @param {'text'|'json'|{ type?: 'text'|'json' }} [opts]
     */
    async get(key, opts) {
      const entry = live(key);
      if (!entry) return null;
      const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    },

    /**
     * @param {string} key
     * @param {'text'|'json'|{ type?: 'text'|'json' }} [opts]
     */
    async getWithMetadata(key, opts) {
      const entry = live(key);
      if (!entry) return { value: null, metadata: null };
      const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
      const value = type === 'json' ? JSON.parse(entry.value) : entry.value;
      return { value, metadata: entry.metadata ?? null };
    },

    /**
     * @param {string} key
     * @param {string|ArrayBuffer|ArrayBufferView|ReadableStream} value
     * @param {{ expirationTtl?: number, expiration?: number, metadata?: unknown }} [opts]
     */
    async put(key, value, opts) {
      const str =
        typeof value === 'string' ? value : Buffer.from(/** @type {ArrayBuffer} */ (value)).toString('utf8');
      let expiresAt = null;
      if (opts?.expirationTtl) expiresAt = Date.now() + opts.expirationTtl * 1000;
      else if (opts?.expiration) expiresAt = opts.expiration * 1000;
      store.set(key, { value: str, expiresAt, metadata: opts?.metadata ?? null });
    },

    /** @param {string} key */
    async delete(key) {
      store.delete(key);
    },

    /** @param {{ prefix?: string }} [opts] */
    async list(opts) {
      const prefix = opts?.prefix ?? '';
      const keys = [];
      for (const key of store.keys()) {
        if (live(key) && key.startsWith(prefix)) keys.push({ name: key });
      }
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
}
