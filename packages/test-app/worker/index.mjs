/**
 * @mieweb/test-app — a tiny worker that touches every portable contract surface.
 *
 * It is a normal Cloudflare worker: `export default { fetch, queue, scheduled }`
 * plus a Durable Object class. The point is that the SAME module runs unchanged
 * on every target —
 *
 *   - cloudflare : `wrangler dev` (Miniflare) with native bindings
 *   - local      : the @mieweb/cloud-local Node host harness (SQLite/fs/memory/in-proc)
 *   - mieweb/os  : the @mieweb/cloud-os adapters (libSQL/S3/Valkey) over docker compose
 *
 * Each route exercises exactly one binding so the shared HTTP assertions in
 * `test/surfaces.mjs` read like a contract checklist. Surfaces a given target
 * can't provide (e.g. Vectorize/AI without a backend) answer `501` with
 * `{ skipped: true }` instead of failing, so one assertion suite passes on all
 * three targets.
 *
 * Bindings (see wrangler.jsonc for the Cloudflare shapes, mieweb.jsonc for the
 * off-Cloudflare drivers):
 *   DB       D1        → sqlite (local) / libSQL (mieweb)
 *   BUCKET   R2        → filesystem (local) / S3-MinIO (mieweb)
 *   CACHE    KV        → in-memory (local) / Valkey (mieweb)
 *   JOBS     Queue     → in-process (local) / Valkey list (mieweb)
 *   COUNTER  DO        → in-process registry (local + mieweb)
 *   VECTORS  Vectorize → sqlite-vec (local) / libSQL vectors (mieweb)
 *   AI       Workers AI→ Ollama if configured, else unsupported
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Treat an UnsupportedBindingError (or a missing binding) as a skipped surface. */
function skipped(surface, err) {
  return json(
    { skipped: true, surface, reason: err ? String(err.message ?? err) : 'binding not configured' },
    501,
  );
}

const isUnsupported = (err) =>
  err && (err.name === 'UnsupportedBindingError' || /not supported on target/i.test(String(err.message)));

/**
 * A target may declare surfaces it intentionally can't serve via the
 * `SKIP_SURFACES` var (comma list), e.g. Cloudflare local dev can't reach
 * Vectorize/Workers AI without `--remote` + credentials. Those answer `501`
 * `{ skipped: true }` so the one shared assertion suite still passes.
 */
function surfaceSkipped(env, surface) {
  const raw = env.SKIP_SURFACES;
  if (!raw) return false;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .includes(surface);
}

/**
 * The Durable Object. A production app would
 * `import { DurableObject } from 'mieweb:workers'` and `extends DurableObject`;
 * a plain class with a `(state, env)` constructor and a `fetch` method is an
 * equally valid DO on Cloudflare and works as-is under the in-process host, so
 * the test app keeps it dependency-free.
 */
export class Counter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const current = (await this.state.storage.get('count')) ?? 0;
    if (request.method === 'POST' || url.searchParams.get('op') === 'incr') {
      const by = Number(url.searchParams.get('by') ?? 1) || 1;
      const next = current + by;
      await this.state.storage.put('count', next);
      return json({ count: next });
    }
    return json({ count: current });
  }
}

// --- Route handlers, one per surface ------------------------------------

async function handleKv(request, url, env) {
  if (!env.CACHE) return skipped('kv');
  if (request.method === 'PUT' || request.method === 'POST') {
    const { key, value } = await request.json();
    await env.CACHE.put(key, value);
    return json({ ok: true, key });
  }
  const key = url.searchParams.get('key');
  const value = await env.CACHE.get(key);
  return json({ key, value });
}

async function handleDb(request, env) {
  if (!env.DB) return skipped('db');
  // Idempotent schema so neither target needs a migration runner for the demo.
  await env.DB.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');
  if (request.method === 'POST') {
    const { name } = await request.json();
    const res = await env.DB.prepare('INSERT INTO items (name) VALUES (?)').bind(name).run();
    return json({ ok: true, id: Number(res?.meta?.last_row_id ?? 0) });
  }
  const all = await env.DB.prepare('SELECT id, name FROM items ORDER BY id').all();
  return json({ items: all.results ?? [] });
}

async function handleR2(request, url, env) {
  if (!env.BUCKET) return skipped('r2');
  const key = url.searchParams.get('key');
  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    await env.BUCKET.put(key, body, { httpMetadata: { contentType: 'text/plain' } });
    return json({ ok: true, key });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ key, value: null }, 404);
  return json({ key, value: await obj.text() });
}

async function handleQueueSend(request, env) {
  if (!env.JOBS) return skipped('queue');
  const { n } = await request.json();
  // The consumer (below) records completion in KV under `job:<n>`.
  await env.JOBS.send({ n });
  return json({ ok: true, queued: n });
}

async function handleQueueResult(url, env) {
  if (!env.CACHE) return skipped('queue');
  const n = url.searchParams.get('n');
  const value = await env.CACHE.get(`job:${n}`);
  return json({ n: Number(n), processed: value === 'done' });
}

async function handleCounter(request, url, env) {
  if (!env.COUNTER) return skipped('do');
  const name = url.searchParams.get('name') ?? 'default';
  const id = env.COUNTER.idFromName(name);
  const stub = env.COUNTER.get(id);
  const res = await stub.fetch(new Request(url, { method: request.method }));
  const body = await res.json();
  return json({ name, count: body.count });
}

async function handleVectorUpsert(request, env) {
  if (surfaceSkipped(env, 'vector')) return skipped('vector');
  if (!env.VECTORS) return skipped('vector');
  try {
    const { id, values, metadata } = await request.json();
    await env.VECTORS.upsert([{ id, values, metadata: metadata ?? {} }]);
    return json({ ok: true, id });
  } catch (err) {
    if (isUnsupported(err)) return skipped('vector', err);
    throw err;
  }
}

async function handleVectorQuery(request, env) {
  if (surfaceSkipped(env, 'vector')) return skipped('vector');
  if (!env.VECTORS) return skipped('vector');
  try {
    const { values, topK } = await request.json();
    const res = await env.VECTORS.query(values, { topK: topK ?? 3, returnMetadata: true });
    return json({ matches: (res.matches ?? []).map((m) => ({ id: m.id, score: m.score })) });
  } catch (err) {
    if (isUnsupported(err)) return skipped('vector', err);
    throw err;
  }
}

async function handleAiEmbed(request, env) {
  if (surfaceSkipped(env, 'ai')) return skipped('ai');
  if (!env.AI) return skipped('ai');
  try {
    const { text } = await request.json();
    const res = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text });
    const dims = Array.isArray(res?.data?.[0]) ? res.data[0].length : 0;
    return json({ ok: true, count: res?.data?.length ?? 0, dims });
  } catch (err) {
    if (isUnsupported(err)) return skipped('ai', err);
    throw err;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/health') {
        return json({ ok: true, surfaces: ['kv', 'db', 'r2', 'queue', 'do', 'vector', 'ai'] });
      }
      if (path === '/kv') return handleKv(request, url, env);
      if (path === '/db/items') return handleDb(request, env);
      if (path === '/r2') return handleR2(request, url, env);
      if (path === '/queue') return handleQueueSend(request, env);
      if (path === '/queue/result') return handleQueueResult(url, env);
      if (path === '/counter') return handleCounter(request, url, env);
      if (path === '/vector') return handleVectorUpsert(request, env);
      if (path === '/vector/query') return handleVectorQuery(request, env);
      if (path === '/ai/embed') return handleAiEmbed(request, env);
      return json({ error: 'not found', path }, 404);
    } catch (err) {
      return json({ error: String(err?.stack ?? err) }, 500);
    }
  },

  /** Queue consumer: marks each job done in KV so the producer can be asserted. */
  async queue(batch, env) {
    for (const message of batch.messages) {
      const { n } = message.body ?? {};
      if (env.CACHE) await env.CACHE.put(`job:${n}`, 'done');
      message.ack();
    }
  },

  /** Cron tick — no-op here; present to prove the handler shape is portable. */
  async scheduled() {},
};
