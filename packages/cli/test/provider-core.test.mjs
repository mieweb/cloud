import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, resolveProvider } from '../src/provider.mjs';
import { delegateToWrangler } from '../src/cloudflare.mjs';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mieweb-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('targetConfig reaches the provider minus bindings (auth-ish names are not secrets)', () => {
  const { context, dispose } = buildContext(
    {
      root: '/x',
      target: 'mieweb',
      raw: {},
      wrangler: {},
      targetConfig: { siteId: 1, authRequired: true, bindings: { DB: { authToken: 's' } } },
    },
    [],
  );
  dispose();
  assert.deepEqual(context.targetConfig, { siteId: 1, authRequired: true });
  assert.equal('mieweb' in context, false);
});

test('a provider installed in the project resolves from the project, incl. ESM-only exports', async (t) => {
  const root = tmp(t);
  const pkg = join(root, 'node_modules', 'esm-only-provider');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"app","type":"module"}');
  writeFileSync(join(pkg, 'package.json'), '{"name":"esm-only-provider","type":"module","exports":{"import":"./i.js"}}');
  writeFileSync(
    join(pkg, 'i.js'),
    "export default { name: 'esm-only', supports: (t) => t === 'custom', deploy: async () => ({ resources: [] }) };",
  );
  const provider = await resolveProvider({ root, target: 'custom', targetConfig: { provider: 'esm-only-provider' } });
  assert.equal(provider?.name, 'esm-only');
});

test('a require-only provider installed in the project resolves from the project', async (t) => {
  const root = tmp(t);
  const pkg = join(root, 'node_modules', 'cjs-only-provider');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"app"}');
  writeFileSync(join(pkg, 'package.json'), '{"name":"cjs-only-provider","exports":{"require":"./i.cjs"}}');
  writeFileSync(
    join(pkg, 'i.cjs'),
    "module.exports = { createProvider: () => ({ name: 'cjs-only', supports: () => true, deploy: async () => ({ resources: [] }) }) };",
  );
  const provider = await resolveProvider({ root, target: 'custom', targetConfig: { provider: 'cjs-only-provider' } });
  assert.equal(provider?.name, 'cjs-only');
});

test('delegateToWrangler returns wrangler’s exit code', async (t) => {
  const dir = tmp(t);
  const fake = join(dir, 'w');
  writeFileSync(fake, '#!/usr/bin/env bash\nexit 3\n');
  chmodSync(fake, 0o755);
  process.env.MIEWEB_REAL_WRANGLER = fake;
  t.after(() => delete process.env.MIEWEB_REAL_WRANGLER);
  assert.equal(await delegateToWrangler(['d1', 'migrations', 'apply'], { cwd: dir }), 3);
});

test('delegateToWrangler reports a missing wrangler instead of throwing', async (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
  const saved = process.env.MIEWEB_REAL_WRANGLER;
  delete process.env.MIEWEB_REAL_WRANGLER;
  t.after(() => {
    if (saved !== undefined) process.env.MIEWEB_REAL_WRANGLER = saved;
  });
  const errors = [];
  t.mock.method(console, 'error', (m) => errors.push(m));
  assert.equal(await delegateToWrangler(['d1', 'list'], { cwd: dir }), 1);
  assert.match(errors.join('\n'), /wrangler binary not found/);
});

test('`mieweb --version` works without wrangler installed', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const dir = tmp(t);
  writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
  const env = { ...process.env };
  delete env.MIEWEB_REAL_WRANGLER;
  const out = execFileSync(process.execPath, [new URL('../src/index.mjs', import.meta.url).pathname, '--version'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /^mieweb \d+\.\d+\.\d+/);
});

test('`mieweb --version` on a non-cloudflare target prints only the version', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const dir = tmp(t);
  writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
  writeFileSync(join(dir, 'mieweb.jsonc'), '{"target":"mieweb"}');
  const out = execFileSync(process.execPath, [new URL('../src/index.mjs', import.meta.url).pathname, '--version'], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(out, /^mieweb \d+\.\d+\.\d+\n$/);
});

test('a provider without login/logout/whoami gets the built-in explanation, not the legacy path', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const dir = tmp(t);
  writeFileSync(join(dir, 'package.json'), '{"name":"app","type":"module"}');
  writeFileSync(join(dir, 'wrangler.jsonc'), '{"name":"app","main":"w.mjs"}');
  writeFileSync(join(dir, 'p.mjs'), "export default { name: 'envonly', supports: () => true, deploy: async () => ({ resources: [] }) };");
  writeFileSync(join(dir, 'mieweb.jsonc'), '{"target":"custom","targets":{"custom":{"provider":"./p.mjs"}}}');
  const cli = new URL('../src/index.mjs', import.meta.url).pathname;
  for (const verb of ['login', 'logout', 'whoami']) {
    const r = spawnSync(process.execPath, [cli, verb], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
    assert.match(r.stderr + r.stdout, /envonly/, verb);
  }
});

test('persistTargetConfig refuses nested and access-key style secrets', async (t) => {
  const { persistTargetConfig } = await import('../src/provider.mjs');
  const dir = tmp(t);
  const config = { root: dir, target: 'mieweb', configPath: join(dir, 'mieweb.jsonc') };
  const logger = { info() {}, warn() {}, error() {} };
  for (const patch of [{ secretAccessKey: 'x' }, { manager: { apiToken: 'x' } }, { list: [{ 'x-api-key': 'x' }] }]) {
    await assert.rejects(persistTargetConfig(config, patch, logger), /secrets belong in the environment/);
  }
  assert.equal(await persistTargetConfig(config, { authRequired: true }, logger), true);
});

test('mieweb init depends on this CLI release and the SDKs its mieweb bindings use', async (t) => {
  const { readFileSync } = await import('node:fs');
  const { runInit } = await import('../src/init.mjs');
  const dir = join(tmp(t), 'app');
  const log = t.mock.method(console, 'log', () => {});
  await runInit([dir]);
  log.mock.restore();
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const cli = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const adapters = JSON.parse(readFileSync(new URL('../../cloud-adapters/package.json', import.meta.url), 'utf8'));
  // Runtime dependencies, not devDependencies: `npm start` runs `mieweb`.
  assert.equal(pkg.dependencies['@mieweb/cli'], `^${cli.version}`);
  assert.equal(pkg.dependencies['@mieweb/cloud'], `^${cli.version}`);
  assert.equal(pkg.devDependencies, undefined);
  for (const sdk of ['@libsql/client', 'ioredis']) {
    assert.equal(pkg.dependencies[sdk], adapters.peerDependencies[sdk], sdk);
  }
});
