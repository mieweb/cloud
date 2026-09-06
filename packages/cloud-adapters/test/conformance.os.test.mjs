// Live conformance tests for the @mieweb/cloud-os adapters.
//
// These run the SAME Cloudflare-shaped contracts as the cloud-local suite, but
// against real infrastructure (libSQL, MinIO, Valkey) brought up by the sibling
// docker-compose.yml. They are the executable proof that the os target honors
// the contracts the worker depends on.
//
//   pnpm --filter @mieweb/cloud-os infra:up   # start libSQL + MinIO + Valkey
//   pnpm --filter @mieweb/cloud-os test
//
// If the infra isn't reachable, the suite self-skips rather than failing, so
// `pnpm -r test` stays green without Docker.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import {
  createLibsqlD1,
  createLibsqlVecIndex,
  createS3Bucket,
  createValkeyKV,
  createValkeyQueue,
} from '../src/index.mjs';

const LIBSQL_URL = process.env.MIEWEB_LIBSQL_URL ?? 'http://localhost:8080';
const S3_ENDPOINT = process.env.MIEWEB_S3_ENDPOINT ?? 'http://localhost:9000';
const VALKEY = { host: '127.0.0.1', port: 6379 };
const S3_CREDS = { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };

async function reachable(url) {
  try {
    // Require a 2xx health response: any HTTP server can answer the port, but
    // only the real service returns ok for its health endpoint. A loose check
    // produces false positives (e.g. a stray dev server on :8080) that then
    // make the live tests fail instead of skip.
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Fail-fast TCP probe. The production Valkey client uses `maxRetriesPerRequest:
// null`, so a `ping()` against a down server would queue and wait forever — we
// must not use it for reachability or `pnpm -r test` hangs without infra.
function tcpReachable({ host, port }, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const haveLibsql = await reachable(`${LIBSQL_URL}/health`);
const haveS3 = await reachable(`${S3_ENDPOINT}/minio/health/live`);
const haveValkey = await tcpReachable(VALKEY);

// --- D1 over libSQL ------------------------------------------------------
test('D1 (libsql): prepare/bind/first/all/run/batch + FTS5', async (t) => {
  if (!haveLibsql) return t.skip('libSQL not reachable');
  const db = await createLibsqlD1({ url: LIBSQL_URL });
  const tbl = `t_${randomUUID().replace(/-/g, '')}`;
  await db.exec(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY, name TEXT)`);
  try {
    await db.prepare(`INSERT INTO ${tbl} (name) VALUES (?)`).bind('alice').run();
    const run = await db.prepare(`INSERT INTO ${tbl} (name) VALUES (?)`).bind('bob').run();
    assert.equal(run.meta.changes, 1);
    assert.ok(run.meta.last_row_id >= 1);

    const first = await db.prepare(`SELECT name FROM ${tbl} WHERE id = ?`).bind(1).first();
    assert.equal(first.name, 'alice');
    assert.equal(await db.prepare(`SELECT name FROM ${tbl} WHERE id = ?`).bind(2).first('name'), 'bob');

    const all = await db.prepare(`SELECT name FROM ${tbl} ORDER BY id`).all();
    assert.deepEqual(all.results.map((r) => r.name), ['alice', 'bob']);

    // Atomic batch.
    const res = await db.batch([
      db.prepare(`INSERT INTO ${tbl} (name) VALUES (?)`).bind('carol'),
      db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`),
    ]);
    assert.equal(res[1].results[0].n, 3);

    // FTS5 lives in libSQL too.
    const fts = `fts_${randomUUID().replace(/-/g, '')}`;
    await db.exec(`CREATE VIRTUAL TABLE ${fts} USING fts5(body)`);
    await db.prepare(`INSERT INTO ${fts}(body) VALUES (?)`).bind('the quick brown fox').run();
    const hit = await db
      .prepare(`SELECT snippet(${fts},0,'[',']','…',4) AS s, bm25(${fts}) AS r FROM ${fts} WHERE ${fts} MATCH ?`)
      .bind('quick')
      .all();
    assert.match(hit.results[0].s, /\[quick\]/);
    assert.equal(typeof hit.results[0].r, 'number');
    await db.exec(`DROP TABLE ${fts}`);
  } finally {
    await db.exec(`DROP TABLE ${tbl}`);
  }
});

// --- Vectorize over libSQL ----------------------------------------------
test('Vectorize (libsql-vec): upsert/query/filter/getByIds/deleteByIds', async (t) => {
  if (!haveLibsql) return t.skip('libSQL not reachable');
  const table = `vec_${randomUUID().replace(/-/g, '')}`;
  const idx = await createLibsqlVecIndex({ url: LIBSQL_URL, dim: 4, table });
  try {
    await idx.upsert([
      { id: 'a', values: [1, 0, 0, 0], metadata: { org: 'o1', kind: 'doc' } },
      { id: 'b', values: [0, 1, 0, 0], metadata: { org: 'o1', kind: 'call' } },
      { id: 'c', values: [0.9, 0.1, 0, 0], metadata: { org: 'o2', kind: 'doc' } },
    ]);

    const top = await idx.query([1, 0, 0, 0], { topK: 2, returnMetadata: true });
    assert.equal(top.matches[0].id, 'a');
    assert.ok(top.matches[0].score > top.matches[1].score);

    const filtered = await idx.query([1, 0, 0, 0], { topK: 5, filter: { org: { $eq: 'o1' } } });
    assert.deepEqual(filtered.matches.map((m) => m.id).sort(), ['a', 'b']);

    const inFilter = await idx.query([1, 0, 0, 0], { topK: 5, filter: { kind: { $in: ['call'] } } });
    assert.deepEqual(inFilter.matches.map((m) => m.id), ['b']);

    await idx.upsert([{ id: 'a', values: [0, 0, 0, 1], metadata: { org: 'o9' } }]);
    const got = await idx.getByIds(['a', 'missing']);
    assert.equal(got.length, 1);
    assert.equal(got[0].metadata.org, 'o9');

    await idx.deleteByIds(['b']);
    const afterDelete = await idx.query([0, 1, 0, 0], { topK: 5 });
    assert.ok(!afterDelete.matches.some((m) => m.id === 'b'));
  } finally {
    await idx._raw.execute(`DROP TABLE IF EXISTS ${table}`);
  }
});

// --- R2 over S3/MinIO ----------------------------------------------------
test('R2 (s3): put/get/range/head/list/delete + metadata', async (t) => {
  if (!haveS3) return t.skip('MinIO not reachable');
  const bucket = `mwc-test-${randomUUID().slice(0, 8)}`;
  const r2 = await createS3Bucket({
    endpoint: S3_ENDPOINT,
    ...S3_CREDS,
    bucket,
    forcePathStyle: true,
  });

  await r2.put('greeting.txt', 'hello world', {
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: { owner: 'alice' },
  });

  const obj = await r2.get('greeting.txt');
  assert.equal(await obj.text(), 'hello world');
  assert.equal(obj.httpMetadata.contentType, 'text/plain');
  assert.equal(obj.customMetadata.owner, 'alice');

  const ranged = await r2.get('greeting.txt', { range: { offset: 6, length: 5 } });
  assert.equal(await ranged.text(), 'world');

  const head = await r2.head('greeting.txt');
  assert.equal(head.size, 11);

  await r2.put('docs/a.txt', 'a');
  await r2.put('docs/b.txt', 'b');
  const listed = await r2.list({ prefix: 'docs/' });
  assert.deepEqual(listed.objects.map((o) => o.key).sort(), ['docs/a.txt', 'docs/b.txt']);

  await r2.delete('greeting.txt');
  assert.equal(await r2.get('greeting.txt'), null);
});

// --- KV over Valkey ------------------------------------------------------
test('KV (valkey): get/put/delete + TTL + metadata + list prefix', async (t) => {
  if (!haveValkey) return t.skip('Valkey not reachable');
  const kv = await createValkeyKV({ ...VALKEY, namespace: `t:${randomUUID().slice(0, 8)}` });
  try {
    await kv.put('a', '1');
    await kv.put('b', '2', { metadata: { tag: 'x' } });
    assert.equal(await kv.get('a'), '1');

    const wm = await kv.getWithMetadata('b');
    assert.equal(wm.value, '2');
    assert.deepEqual(wm.metadata, { tag: 'x' });

    const listed = await kv.list({ prefix: '' });
    assert.deepEqual(listed.keys.map((k) => k.name).sort(), ['a', 'b']);

    await kv.delete('a');
    assert.equal(await kv.get('a'), null);

    await kv.put('ttl', 'gone', { expirationTtl: 1 });
    assert.equal(await kv.get('ttl'), 'gone');
  } finally {
    await kv._close();
  }
});

// --- Queue over Valkey ---------------------------------------------------
test('Queue (valkey-queue): send dispatches to the worker queue handler', async (t) => {
  if (!haveValkey) return t.skip('Valkey not reachable');
  const delivered = [];
  const env = {};
  const consumer = (batch) => {
    for (const m of batch.messages) {
      delivered.push(m.body);
      m.ack();
    }
  };
  const q = await createValkeyQueue('jobs', () => consumer, () => env, {
    ...VALKEY,
    namespace: `q:${randomUUID().slice(0, 8)}`,
    pollMs: 30,
  });
  try {
    await q.send({ hello: 'world' });
    await q.sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
    // Wait for the poller to drain.
    const deadline = Date.now() + 3000;
    while (delivered.length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(delivered.length, 3);
    assert.ok(delivered.some((d) => d.hello === 'world'));
  } finally {
    await q._close();
  }
});
