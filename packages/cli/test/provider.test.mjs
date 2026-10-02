import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, providerImplements } from '../src/provider.mjs';

test('mieweb target resolves the built-in opensource-server provider', async () => {
  // root outside the repo: the provider must resolve from the CLI's own deps.
  const p = await resolveProvider({ target: 'mieweb', root: '/', targetConfig: {} });
  assert.equal(p.name, 'opensource-server');
  assert.ok(p.supports('mieweb'));
});

test('verbs the provider lacks fall back to the legacy path', async () => {
  const p = await resolveProvider({ target: 'mieweb', root: '/', targetConfig: {} });
  for (const v of ['deploy', 'destroy', 'tail', 'whoami', 'login', 'logout']) assert.ok(providerImplements(p, v), v);
  for (const v of ['dev']) assert.equal(providerImplements(p, v), false, v);
});

test('persistTargetConfig writes into mieweb.jsonc, keeping comments; refuses secrets', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { persistTargetConfig } = await import('../src/provider.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'mieweb-persist-'));
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn() {}, error() {} };
  try {
    const file = join(dir, 'mieweb.jsonc');
    writeFileSync(file, '{\n  // keep me\n  "target": "mieweb",\n  "targets": { "mieweb": { "port": 8787 } }\n}\n');
    const config = { root: dir, target: 'mieweb', configPath: file };
    assert.equal(await persistTargetConfig(config, { siteId: 2 }, logger), true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\/\/ keep me/);
    assert.match(text, /"siteId": 2/);
    assert.match(text, /"port": 8787/);
    assert.equal(await persistTargetConfig(config, { siteId: 2 }, logger), false, 'no-op when unchanged');
    await assert.rejects(persistTargetConfig(config, { apiToken: 'x' }, logger), /secrets belong in the environment/);
    assert.match(logs[0], /targets\.mieweb\.siteId = 2/);

    // No mieweb.jsonc yet (config came from wrangler.jsonc): create one in root.
    rmSync(file);
    await persistTargetConfig({ root: dir, target: 'mieweb', configPath: join(dir, 'wrangler.jsonc') }, { siteId: 3 }, logger);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { targets: { mieweb: { siteId: 3 } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
