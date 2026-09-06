// Conformance tests for the @mieweb/cloud-local adapters.
//
// These lock in the Cloudflare-shaped contracts every local driver must honor,
// so the same worker handler runs unchanged off Cloudflare — and so future
// `os`/`aws` adapters have an executable spec to pass.
//
// Run with: node --test  (no test framework dependency).
//
// SQLite-backed tests are skipped automatically when better-sqlite3 /
// sqlite-vec aren't installed, so the suite stays green in minimal CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMemoryKV,
  createInprocQueue,
  createSqliteD1,
  createSqliteVecIndex,
  createAiBackend,
} from '../src/index.mjs';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function hasSqlite() {
  try {
    await import('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

async function hasSqliteVec() {
  if (!(await hasSqlite())) return false;
  try {
    await import('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

// --- KV contract ---------------------------------------------------------
test('KV (memory): get/put/delete + TTL + list prefix', async () => {
  const kv = createMemoryKV();
  await kv.put('a', '1');
  await kv.put('b', '2', { metadata: { tag: 'x' } });
  assert.equal(await kv.get('a'), '1');

  const wm = await kv.getWithMetadata('b');
  assert.equal(wm.value, '2');
  assert.deepEqual(wm.metadata, { tag: 'x' });

  const listed = await kv.list({ prefix: '' });
  assert.equal(listed.keys.length, 2);

  await kv.delete('a');
  assert.equal(await kv.get('a'), null);

  await kv.put('ttl', 'gone', { expirationTtl: -1 });
  assert.equal(await kv.get('ttl'), null);
});

// --- Queue contract ------------------------------------------------------
test('Queue (inproc): send dispatches to the worker queue handler', async () => {
  const delivered = [];
  // The host passes a bound `worker.queue` function as the consumer.
  const consumer = (batch) => {
    for (const m of batch.messages) {
      delivered.push(m.body);
      m.ack();
    }
  };
  const env = {};
  const q = createInprocQueue('jobs', () => consumer, () => env);
  await q.send({ hello: 'world' });
  await q.sendBatch([{ body: { n: 1 } }, { body: { n: 2 } }]);
  // Let the microtask/timer dispatch run.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(delivered.length, 3);
  assert.deepEqual(delivered[0], { hello: 'world' });
});

// --- D1 contract ---------------------------------------------------------
test('D1 (sqlite): prepare/bind/first/all/run + FTS5 bm25/snippet', async (t) => {
  if (!(await hasSqlite())) return t.skip('better-sqlite3 not installed');
  const dir = tmp('mwc-d1-');
  try {
    const db = await createSqliteD1(join(dir, 'd1.sqlite'));
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await db.prepare('INSERT INTO t (name) VALUES (?)').bind('alice').run();
    await db.prepare('INSERT INTO t (name) VALUES (?)').bind('bob').run();

    const one = await db.prepare('SELECT name FROM t WHERE id = ?').bind(1).first();
    assert.equal(one.name, 'alice');
    assert.equal(await db.prepare('SELECT name FROM t WHERE id = ?').bind(2).first('name'), 'bob');

    const all = await db.prepare('SELECT name FROM t ORDER BY id').all();
    assert.deepEqual(all.results.map((r) => r.name), ['alice', 'bob']);

    await db.exec('CREATE VIRTUAL TABLE docs USING fts5(body)');
    await db.prepare('INSERT INTO docs(body) VALUES (?)').bind('the quick brown fox').run();
    const hit = await db
      .prepare("SELECT snippet(docs,0,'[',']','…',4) AS s, bm25(docs) AS r FROM docs WHERE docs MATCH ?")
      .bind('quick')
      .all();
    assert.equal(hit.results.length, 1);
    assert.match(hit.results[0].s, /\[quick\]/);
    assert.equal(typeof hit.results[0].r, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Vectorize contract --------------------------------------------------
test('Vectorize (sqlite-vec): upsert/query/filter/getByIds/deleteByIds', async (t) => {
  if (!(await hasSqliteVec())) return t.skip('better-sqlite3/sqlite-vec not installed');
  const dir = tmp('mwc-vec-');
  try {
    const idx = await createSqliteVecIndex(join(dir, 'idx.sqlite'), { dim: 4 });
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

    // upsert replaces by id
    await idx.upsert([{ id: 'a', values: [0, 0, 0, 1], metadata: { org: 'o9' } }]);
    const got = await idx.getByIds(['a', 'missing']);
    assert.equal(got.length, 1);
    assert.equal(got[0].metadata.org, 'o9');

    await idx.deleteByIds(['b']);
    const afterDelete = await idx.query([0, 1, 0, 0], { topK: 5 });
    assert.ok(!afterDelete.matches.some((m) => m.id === 'b'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- AI contract ---------------------------------------------------------
test('AI (ollama): run({text}) embeddings + toMarkdown passthrough', async () => {
  const ai = createAiBackend({
    host: 'http://localhost:11434/',
    models: { embed: 'nomic-embed-text' },
    // Stub fetch so the test is hermetic (no running Ollama needed).
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(url, 'http://localhost:11434/api/embed');
      assert.equal(body.model, 'nomic-embed-text');
      return { ok: true, json: async () => ({ embeddings: body.input.map(() => [0.1, 0.2, 0.3]) }) };
    },
  });

  const batch = await ai.run('@cf/baai/bge-base-en-v1.5', { text: ['x', 'y'] });
  assert.equal(batch.data.length, 2);
  assert.equal(batch.data[0].length, 3);

  const single = await ai.run('@cf/baai/bge-base-en-v1.5', { text: 'solo' });
  assert.equal(single.data.length, 1);

  const md = await ai.toMarkdown([
    { name: 'a.txt', blob: new Blob(['hello'], { type: 'text/plain' }) },
    { name: 'b.bin', blob: new Blob([new Uint8Array([0, 1])], { type: 'application/octet-stream' }) },
  ]);
  assert.equal(md[0].data, 'hello');
  assert.equal(md[1].data, '');
});
