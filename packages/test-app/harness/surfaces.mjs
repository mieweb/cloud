// Shared, target-agnostic contract checks for the test app.
//
// Every check drives one binding through plain HTTP, so the exact same suite
// proves the @mieweb/cloud layer on Cloudflare, local Node, and mieweb/os.
// Optional surfaces (Vectorize / AI) that answer `501 { skipped: true }` are
// recorded as skipped instead of failing.

import assert from 'node:assert/strict';

/**
 * @param {string} baseUrl  e.g. http://127.0.0.1:8801
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ passed: string[], skipped: string[] }>}
 */
export async function runSurfaceChecks(baseUrl, log = () => {}) {
  const passed = [];
  const skipped = [];

  async function req(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body:
        body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data };
  }

  /** Run an optional surface; treat 501 as a skip. Returns true if it ran. */
  async function optional(name, fn) {
    try {
      const ran = await fn();
      if (ran === 'skip') {
        skipped.push(name);
        log(`  - ${name}: skipped`);
        return false;
      }
      passed.push(name);
      log(`  ✓ ${name}`);
      return true;
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  }

  async function required(name, fn) {
    await fn();
    passed.push(name);
    log(`  ✓ ${name}`);
  }

  // --- health ------------------------------------------------------------
  await required('health', async () => {
    const { status, data } = await req('GET', '/health');
    assert.equal(status, 200, 'health status');
    assert.equal(data.ok, true, 'health ok');
  });

  // --- KV ----------------------------------------------------------------
  await required('kv', async () => {
    const put = await req('PUT', '/kv', { key: 'greeting', value: 'hello-kv' });
    assert.equal(put.status, 200);
    const got = await req('GET', '/kv?key=greeting');
    assert.equal(got.data.value, 'hello-kv', 'kv roundtrip');
  });

  // --- D1 ----------------------------------------------------------------
  await required('db', async () => {
    const a = await req('POST', '/db/items', { name: 'alice' });
    assert.equal(a.status, 200);
    assert.ok(a.data.id >= 1, 'insert returns row id');
    await req('POST', '/db/items', { name: 'bob' });
    const list = await req('GET', '/db/items');
    const names = (list.data.items ?? []).map((r) => r.name);
    assert.ok(names.includes('alice') && names.includes('bob'), 'db lists rows');
  });

  // --- R2 ----------------------------------------------------------------
  await required('r2', async () => {
    const put = await req('PUT', '/r2?key=note.txt', 'r2-works');
    assert.equal(put.status, 200);
    const got = await req('GET', '/r2?key=note.txt');
    assert.equal(got.data.value, 'r2-works', 'r2 roundtrip');
  });

  // --- Queue (async: producer → consumer writes back to KV) --------------
  await required('queue', async () => {
    const n = Math.floor(Math.random() * 1e6);
    const send = await req('POST', '/queue', { n });
    assert.equal(send.status, 200);
    let processed = false;
    for (let i = 0; i < 40 && !processed; i += 1) {
      const r = await req('GET', `/queue/result?n=${n}`);
      processed = r.data.processed === true;
      if (!processed) await new Promise((res) => setTimeout(res, 150));
    }
    assert.ok(processed, 'queue consumer processed the job');
  });

  // --- Durable Object ----------------------------------------------------
  await required('do', async () => {
    const name = `widget-${Math.random().toString(36).slice(2)}`;
    const one = await req('POST', `/counter?name=${name}`);
    assert.equal(one.data.count, 1, 'DO first increment');
    const two = await req('POST', `/counter?name=${name}`);
    assert.equal(two.data.count, 2, 'DO second increment persists state');
    const read = await req('GET', `/counter?name=${name}`);
    assert.equal(read.data.count, 2, 'DO read-back');
  });

  // --- Vectorize (optional) ---------------------------------------------
  await optional('vector', async () => {
    const v1 = [1, 0, 0, 0, 0, 0, 0, 0];
    const v2 = [0, 1, 0, 0, 0, 0, 0, 0];
    const up1 = await req('POST', '/vector', { id: 'v1', values: v1, metadata: { kind: 'a' } });
    if (up1.status === 501) return 'skip';
    assert.equal(up1.status, 200);
    await req('POST', '/vector', { id: 'v2', values: v2, metadata: { kind: 'b' } });
    const q = await req('POST', '/vector/query', { values: v1, topK: 2 });
    if (q.status === 501) return 'skip';
    assert.equal(q.data.matches[0].id, 'v1', 'nearest vector is v1');
    return true;
  });

  // --- AI (optional) -----------------------------------------------------
  await optional('ai', async () => {
    const r = await req('POST', '/ai/embed', { text: 'hello world' });
    if (r.status === 501) return 'skip';
    assert.equal(r.status, 200);
    assert.ok(r.data.dims > 0, 'embedding has dimensions');
    return true;
  });

  return { passed, skipped };
}
