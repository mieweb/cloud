import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProviderConformance } from '@mieweb/deploy-contract/testkit';
import provider from '@mieweb/deploy-wrangler';

/**
 * Structural conformance for the reference provider. We run the kit WITHOUT
 * `live: true` so the suite validates the interface contract (name, supports,
 * deploy signature, result shape rules) without actually invoking wrangler /
 * hitting Cloudflare. A live variant belongs in an integration job with real
 * credentials + the test-app fixture.
 */

test('supports only the cloudflare target', () => {
  assert.equal(provider.supports('cloudflare'), true);
  assert.equal(provider.supports('mieweb'), false);
  assert.equal(provider.supports('local'), false);
});

test('implements the auth verbs (login/logout/whoami)', () => {
  assert.equal(typeof provider.login, 'function');
  assert.equal(typeof provider.logout, 'function');
  assert.equal(typeof provider.whoami, 'function');
});

test('passes the contract conformance test-kit (structural)', async () => {
  const report = await runProviderConformance(provider, {
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

test('conformance kit does not deploy when the provider fails the structural checks', async () => {
  let deployed = false;
  const wrongTarget = {
    name: 'wrong-target',
    supports: () => false,
    async deploy() {
      deployed = true;
      return { resources: [] };
    },
  };
  const report = await runProviderConformance(wrongTarget, { target: 'cloudflare', manifest: {}, live: true });
  assert.equal(deployed, false);
  assert.ok(report.failures.some((f) => /supports/.test(f.name)));
});

/* ------------------------------------------------------------------ *
 * Hermetic fake-wrangler coverage for the reference provider's actual
 * subprocess paths (deploy/argv/reload/resource-extraction, auth mapping,
 * whoami classification). No network, no real wrangler — a shell stub echoes
 * args + can simulate manifest write-back and specific exit/stderr.
 * ------------------------------------------------------------------ */

/**
 * Run `fn` against a temp project whose wrangler is a bash stub running
 * `script`, then clean up. `fx.ctx(extra)` builds a DeployContext.
 */
async function withFake(manifest, script, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mieweb-wrangler-'));
  const manifestPath = join(dir, 'wrangler.jsonc');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const fake = join(dir, 'fake-wrangler');
  const argsLog = join(dir, 'args.log');
  writeFileSync(fake, `#!/usr/bin/env bash\necho "$@" >> "${argsLog}"\n${script}\n`);
  chmodSync(fake, 0o755);
  const fx = {
    manifestPath,
    ctx: (extra = {}) => ({
      root: dir,
      target: 'cloudflare',
      manifest,
      manifestPath,
      targetConfig: {},
      argv: [],
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      ...extra,
    }),
    readArgs: () => readFileSync(argsLog, 'utf8'),
  };
  process.env.MIEWEB_REAL_WRANGLER = fake;
  process.env.MF = manifestPath;
  try {
    await fn(fx);
  } finally {
    delete process.env.MIEWEB_REAL_WRANGLER;
    delete process.env.MF;
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNAUTH_WHOAMI = 'if [ "$1" = "whoami" ]; then echo "You are not authenticated" >&2; exit 1; fi\nexit 1';

test('deploy: forwards --config + argv, extracts resources, reloads written-back ids', async () => {
  // Fake wrangler writes a KV id back into the manifest on deploy.
  const manifest = {
    name: 'demo',
    d1_databases: [{ binding: 'DB', database_id: 'd1' }],
    vectorize: [{ binding: 'VEC', index_name: 'idx' }],
    kv_namespaces: [{ binding: 'S' }],
    ai: { binding: 'AI' },
  };
  const script = `
if [ "$1" = "deploy" ]; then
  node -e 'const f=process.env.MF;const j=JSON.parse(require("fs").readFileSync(f));j.kv_namespaces[0].id="kv-new";require("fs").writeFileSync(f,JSON.stringify(j))'
fi
exit 0`;
  await withFake(manifest, script, async (fx) => {
    const res = await provider.deploy(fx.ctx({ argv: ['--env', 'prod'] }));
    const byBinding = Object.fromEntries(res.resources.map((r) => [r.binding, r]));
    const args = fx.readArgs();
    assert.match(args, /deploy/);
    assert.match(args, /--config/);
    assert.match(args, /--env prod/);
    // resource extraction: vectorize via index_name, KV id reloaded, AI omitted
    assert.equal(byBinding.DB.id, 'd1');
    assert.equal(byBinding.VEC.kind, 'vector');
    assert.equal(byBinding.VEC.id, 'idx');
    assert.equal(byBinding.S.id, 'kv-new');
    assert.equal(byBinding.AI, undefined);
  });
});

test('deploy: auth failure (whoami probe unauth) maps to AuthError; generic failure does not', async () => {
  await withFake({ name: 'demo' }, UNAUTH_WHOAMI, async (fx) => {
    await assert.rejects(() => provider.deploy(fx.ctx()), (e) => e.name === 'AuthError');
  });
  // deploy fails but whoami reports authenticated (exit 0) → generic failure.
  const net = 'if [ "$1" = "whoami" ]; then exit 0; fi\necho "getaddrinfo ENOTFOUND" >&2; exit 1';
  await withFake({ name: 'demo' }, net, async (fx) => {
    await assert.rejects(
      () => provider.deploy(fx.ctx()),
      (e) => e.name !== 'AuthError' && /exited with code 1/.test(e.message),
    );
  });
});

test("deploy: the verb's own 403 is authoritative even when whoami is authenticated", async () => {
  // Valid token lacking operation permission: deploy prints 403, whoami exits 0.
  const script = 'if [ "$1" = "whoami" ]; then exit 0; fi\necho "A request failed [code: 10000] 403" >&2; exit 1';
  await withFake({ name: 'demo' }, script, async (fx) => {
    await assert.rejects(() => provider.deploy(fx.ctx()), (e) => e.name === 'AuthError');
  });
});

test('whoami: authed=0, explicit-unauth via marker, network failure throws undetermined', async () => {
  await withFake({}, 'exit 0', async (fx) => {
    assert.equal((await provider.whoami(fx.ctx())).authenticated, true);
  });
  await withFake({}, 'echo "You are not authenticated" >&2; exit 1', async (fx) => {
    assert.equal((await provider.whoami(fx.ctx())).authenticated, false);
  });
  await withFake({}, 'echo "getaddrinfo ENOTFOUND" >&2; exit 1', async (fx) => {
    await assert.rejects(() => provider.whoami(fx.ctx()), /could not determine/);
  });
});

test('dev: a credentialed 401/403 exit rejects `closed` with AuthError', async () => {
  await withFake({ name: 'demo' }, UNAUTH_WHOAMI, async (fx) => {
    const handle = await provider.dev(fx.ctx());
    await assert.rejects(() => handle.closed, (e) => e.name === 'AuthError');
  });
});
