import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProviderConformance } from '@mieweb/deploy-contract/testkit';
import provider, { wranglerProvider, createProvider } from '@mieweb/deploy-wrangler';

/**
 * Structural conformance for the reference provider. We run the kit WITHOUT
 * `live: true` so the suite validates the interface contract (name, supports,
 * deploy signature, result shape rules) without actually invoking wrangler /
 * hitting Cloudflare. A live variant belongs in an integration job with real
 * credentials + the test-app fixture.
 */

test('exports a DeployProvider by default and via factory', () => {
  assert.equal(provider, wranglerProvider);
  assert.equal(createProvider(process.env), wranglerProvider);
  assert.equal(typeof wranglerProvider.deploy, 'function');
});

test('supports only the cloudflare target', () => {
  assert.equal(wranglerProvider.supports('cloudflare'), true);
  assert.equal(wranglerProvider.supports('mieweb'), false);
  assert.equal(wranglerProvider.supports('local'), false);
});

test('implements the auth verbs (login/logout/whoami)', () => {
  assert.equal(typeof wranglerProvider.login, 'function');
  assert.equal(typeof wranglerProvider.logout, 'function');
  assert.equal(typeof wranglerProvider.whoami, 'function');
});

test('passes the contract conformance test-kit (structural)', async () => {
  const report = await runProviderConformance(wranglerProvider, {
    target: 'cloudflare',
    manifest: {
      name: 'demo',
      d1_databases: [{ binding: 'DB', database_id: 'abc-123' }],
      r2_buckets: [{ binding: 'RECORDINGS', bucket_name: 'demo-recordings' }],
      kv_namespaces: [{ binding: 'SESSIONS', id: 'kv-1' }],
    },
  });
  assert.deepEqual(
    report.failures,
    [],
    `conformance failures:\n${report.failures.map((f) => `  - ${f.name}: ${f.detail}`).join('\n')}`,
  );
});

test('conformance kit rejects a bogus ResourceKind (live)', async () => {
  // A stub provider that returns an invalid `kind` must fail the result-shape
  // check — proving the kit validates against the closed ResourceKind union.
  const bogus = {
    name: 'bogus',
    supports: () => true,
    async deploy() {
      return { resources: [{ binding: 'X', kind: 'not-a-kind', id: 'y' }] };
    },
  };
  const report = await runProviderConformance(bogus, {
    target: 'cloudflare',
    manifest: {},
    live: true,
  });
  assert.ok(
    report.failures.some((f) => /ResourceKind/.test(f.detail ?? '')),
    'expected a ResourceKind validation failure',
  );
});

/* ------------------------------------------------------------------ *
 * Hermetic fake-wrangler coverage for the reference provider's actual
 * subprocess paths (deploy/argv/reload/resource-extraction, auth mapping,
 * whoami classification). No network, no real wrangler — a shell stub echoes
 * args + can simulate manifest write-back and specific exit/stderr.
 * ------------------------------------------------------------------ */

/** Create a temp project with a fake wrangler; returns helpers + cleanup. */
function makeFixture(manifest, script) {
  const dir = mkdtempSync(join(tmpdir(), 'mieweb-wrangler-'));
  const manifestPath = join(dir, 'wrangler.jsonc');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const fake = join(dir, 'fake-wrangler');
  const argsLog = join(dir, 'args.log');
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${argsLog}"\n${script}\n`);
  chmodSync(fake, 0o755);
  const ctx = (extra = {}) => ({
    root: dir,
    target: 'cloudflare',
    manifest,
    manifestPath,
    mieweb: {},
    targetConfig: {},
    argv: [],
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    ...extra,
  });
  return {
    dir,
    fake,
    ctx,
    readArgs: () => (readFileSync(argsLog, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('deploy: forwards --config + argv, extracts resources, reloads written-back ids', async () => {
  // Fake wrangler writes a KV id back into the manifest on deploy.
  const fx = makeFixture(
    {
      name: 'demo',
      d1_databases: [{ binding: 'DB', database_id: 'd1' }],
      vectorize: [{ binding: 'VEC', index_name: 'idx' }],
      kv_namespaces: [{ binding: 'S' }],
      ai: { binding: 'AI' },
    },
    `
if [ "$1" = "deploy" ]; then
  node -e 'const f=process.env.MF;const j=JSON.parse(require("fs").readFileSync(f));j.kv_namespaces[0].id="kv-new";require("fs").writeFileSync(f,JSON.stringify(j))'
fi
exit 0`,
  );
  process.env.MIEWEB_REAL_WRANGLER = fx.fake;
  process.env.MF = join(fx.dir, 'wrangler.jsonc');
  try {
    const res = await wranglerProvider.deploy(fx.ctx({ argv: ['--env', 'prod'] }));
    const byBinding = Object.fromEntries(res.resources.map((r) => [r.binding, r]));
    // argv + --config forwarded
    const args = fx.readArgs();
    assert.match(args, /deploy/);
    assert.match(args, /--config/);
    assert.match(args, /--env prod/);
    // resource extraction: vectorize via index_name, KV id reloaded, AI omitted
    assert.equal(byBinding.DB.id, 'd1');
    assert.equal(byBinding.VEC.kind, 'vector');
    assert.equal(byBinding.VEC.id, 'idx');
    assert.equal(byBinding.S.id, 'kv-new'); // reloaded from written-back manifest
    assert.equal(byBinding.AI, undefined); // AI not reported
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    delete process.env.MF;
    fx.cleanup();
  }
});

test('deploy: auth failure (whoami probe unauth) maps to AuthError; generic failure does not', async () => {
  // deploy fails; the whoami probe reports NOT authenticated → AuthError.
  const authFx = makeFixture(
    { name: 'demo' },
    'if [ "$1" = "whoami" ]; then echo "You are not authenticated" >&2; exit 1; fi\nexit 1',
  );
  process.env.MIEWEB_REAL_WRANGLER = authFx.fake;
  try {
    await assert.rejects(() => wranglerProvider.deploy(authFx.ctx()), (e) => e.name === 'AuthError');
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    authFx.cleanup();
  }

  // deploy fails but whoami reports authenticated (exit 0) → generic failure.
  const netFx = makeFixture(
    { name: 'demo' },
    'if [ "$1" = "whoami" ]; then exit 0; fi\necho "getaddrinfo ENOTFOUND" >&2; exit 1',
  );
  process.env.MIEWEB_REAL_WRANGLER = netFx.fake;
  try {
    await assert.rejects(
      () => wranglerProvider.deploy(netFx.ctx()),
      (e) => e.name !== 'AuthError' && /exited with code 1/.test(e.message),
    );
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    netFx.cleanup();
  }
});

test("deploy: the verb's own 403 is authoritative even when whoami is authenticated", async () => {
  // Valid token lacking operation permission: deploy prints 403, whoami exits 0.
  // The verb's own stderr must win (path 1), yielding AuthError — a whoami-only
  // probe would miss this (whoami is authenticated).
  const fx = makeFixture(
    { name: 'demo' },
    'if [ "$1" = "whoami" ]; then exit 0; fi\necho "A request failed [code: 10000] 403" >&2; exit 1',
  );
  process.env.MIEWEB_REAL_WRANGLER = fx.fake;
  try {
    await assert.rejects(() => wranglerProvider.deploy(fx.ctx()), (e) => e.name === 'AuthError');
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    fx.cleanup();
  }
});

test('whoami: authed=0, explicit-unauth via marker, network failure throws undetermined', async () => {
  const okFx = makeFixture({}, 'exit 0');
  process.env.MIEWEB_REAL_WRANGLER = okFx.fake;
  try {
    assert.equal((await wranglerProvider.whoami(okFx.ctx())).authenticated, true);
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    okFx.cleanup();
  }

  const unauthFx = makeFixture({}, 'echo "You are not authenticated" >&2; exit 1');
  process.env.MIEWEB_REAL_WRANGLER = unauthFx.fake;
  try {
    assert.equal((await wranglerProvider.whoami(unauthFx.ctx())).authenticated, false);
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    unauthFx.cleanup();
  }

  const netFx = makeFixture({}, 'echo "getaddrinfo ENOTFOUND" >&2; exit 1');
  process.env.MIEWEB_REAL_WRANGLER = netFx.fake;
  try {
    await assert.rejects(() => wranglerProvider.whoami(netFx.ctx()), /could not determine/);
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    netFx.cleanup();
  }
});

test('dev: a credentialed 401/403 exit rejects `closed` with AuthError', async () => {
  // dev exits non-zero; the whoami probe reports NOT authenticated → AuthError.
  const fx = makeFixture(
    { name: 'demo' },
    'if [ "$1" = "whoami" ]; then echo "You are not authenticated" >&2; exit 1; fi\nexit 1',
  );
  process.env.MIEWEB_REAL_WRANGLER = fx.fake;
  try {
    const handle = await wranglerProvider.dev(fx.ctx());
    await assert.rejects(() => handle.closed, (e) => e.name === 'AuthError');
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    fx.cleanup();
  }
});
