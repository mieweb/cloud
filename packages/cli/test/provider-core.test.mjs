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

test('delegateToWrangler returns wrangler’s exit code', async (t) => {
  const dir = tmp(t);
  const fake = join(dir, 'w');
  writeFileSync(fake, '#!/usr/bin/env bash\nexit 3\n');
  chmodSync(fake, 0o755);
  process.env.MIEWEB_REAL_WRANGLER = fake;
  t.after(() => delete process.env.MIEWEB_REAL_WRANGLER);
  assert.equal(await delegateToWrangler(['d1', 'migrations', 'apply'], { cwd: dir }), 3);
});
