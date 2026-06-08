// `node --test` entry: boot the LOCAL target in-process and run the shared
// surface checks. This needs no external services (SQLite/fs/memory/in-proc),
// so it runs as part of `pnpm -r test` and in CI without Docker.
//
// The cross-target runner (cf / docker / all) lives in ./run.mjs.

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

import { loadConfig } from '@mieweb/cli/src/config.mjs';
import { runSurfaceChecks } from '../harness/surfaces.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function hasSqlite() {
  try {
    await import('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

test('local target: all contract surfaces', async (t) => {
  if (!(await hasSqlite())) {
    return t.skip('better-sqlite3 not installed — local SQLite/Vectorize unavailable');
  }

  // Fresh state for a deterministic run.
  rmSync(resolve(appDir, '.data/local'), { recursive: true, force: true });

  const config = loadConfig({ cwd: appDir, overrideTarget: 'local' });
  const { startLocalHost } = await import('@mieweb/cloud-local/host');
  const handle = await startLocalHost({ config });
  const baseUrl = `http://127.0.0.1:${handle.port}`;

  try {
    const { passed, skipped } = await runSurfaceChecks(baseUrl, (l) => t.diagnostic(l));
    t.diagnostic(`passed: ${passed.join(', ')}`);
    if (skipped.length) t.diagnostic(`skipped: ${skipped.join(', ')}`);
    // Core surfaces must always pass on local; Vectorize is wired (sqlite-vec).
    for (const surface of ['health', 'kv', 'db', 'r2', 'queue', 'do', 'vector']) {
      if (!passed.includes(surface)) {
        throw new Error(`expected surface "${surface}" to pass on local, but it did not`);
      }
    }
  } finally {
    handle.stop();
  }
});
