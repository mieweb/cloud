#!/usr/bin/env node
// Cross-target conformance runner for the @mieweb/cloud test app.
//
//   node harness/run.mjs --target local     # in-process Node adapters
//   node harness/run.mjs --target docker     # mieweb/os adapters over docker compose
//   node harness/run.mjs --target cf         # Cloudflare (wrangler dev / Miniflare)
//   node harness/run.mjs --target all        # every target above
//
// For each target it boots the SAME worker (via the `mieweb` CLI, or wrangler
// for cf), runs the shared surface checks in harness/surfaces.mjs over HTTP,
// then tears everything down. Exit code is non-zero if any selected target
// fails. Targets that can't run (no Docker, no wrangler) are skipped, not
// failed.
//
// Flags:
//   --keep-infra   leave the docker compose stack running after the docker run
//   --strict-cf    treat an unavailable Cloudflare/wrangler as a failure

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';

import { runSurfaceChecks } from './surfaces.mjs';

const harnessDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(harnessDir, '..');
const cliPath = resolve(appDir, '../cli/src/index.mjs');
const composeFile = resolve(appDir, '../cloud-os/docker-compose.yml');
const composeDir = dirname(composeFile);

const PORTS = { local: 8801, mieweb: 8802, cf: 8803 };

const argv = process.argv.slice(2);
const targetArg = readFlagValue('--target') ?? 'local';
const keepInfra = argv.includes('--keep-infra');
const strictCf = argv.includes('--strict-cf');

const targets = targetArg === 'all' ? ['cf', 'local', 'docker'] : [targetArg];

const log = (line) => process.stdout.write(`${line}\n`);

async function run() {
  const results = [];
  for (const target of targets) {
    log(`\n=== target: ${target} ===`);
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runTarget(target));
    } catch (err) {
      results.push({ target, status: 'fail', error: err.message });
      log(`  ✗ ${err.message}`);
    }
  }

  log('\n=== summary ===');
  let failed = 0;
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'skip' ? '-' : '✗';
    const detail =
      r.status === 'pass'
        ? `passed [${r.passed.join(', ')}]${r.skipped?.length ? ` skipped [${r.skipped.join(', ')}]` : ''}`
        : r.status === 'skip'
          ? `skipped (${r.reason})`
          : r.error;
    log(`  ${icon} ${r.target}: ${detail}`);
    if (r.status === 'fail') failed += 1;
  }
  return failed > 0 ? 1 : 0;
}

/** @param {'local'|'docker'|'cf'} target */
async function runTarget(target) {
  if (target === 'local') return runHostTarget('local', { mustPass: CORE.concat('vector') });
  if (target === 'docker') return runDocker();
  if (target === 'cf') return runCloudflare();
  return { target, status: 'skip', reason: `unknown target "${target}"` };
}

const CORE = ['health', 'kv', 'db', 'r2', 'queue', 'do'];

/** Boot a Node host target (local or mieweb) via the mieweb CLI and check it. */
async function runHostTarget(miewebTarget, { mustPass }) {
  if (miewebTarget === 'local') rmSync(resolve(appDir, '.data/local'), { recursive: true, force: true });
  const port = PORTS[miewebTarget];
  const child = spawn('node', [cliPath, '--target', miewebTarget, 'dev'], {
    cwd: appDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = captureTail(child);
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, 30_000, child, tail);
    const { passed, skipped } = await runSurfaceChecks(`http://127.0.0.1:${port}`, log);
    assertMustPass(passed, mustPass);
    return { target: miewebTarget === 'local' ? 'local' : 'docker', status: 'pass', passed, skipped };
  } finally {
    await stopProcess(child);
  }
}

async function runDocker() {
  if (!commandExists('docker')) {
    return { target: 'docker', status: 'skip', reason: 'docker not installed' };
  }
  log('  bringing up docker compose (libSQL + MinIO + Valkey)…');
  const up = spawnSync('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'], {
    cwd: composeDir,
    stdio: 'inherit',
  });
  if (up.status !== 0) {
    return { target: 'docker', status: 'skip', reason: 'docker compose up failed' };
  }
  try {
    // The libSQL image has no in-container health probe, so confirm readiness
    // over HTTP from the host before booting the worker (avoids a startup race).
    await waitForUrl('http://localhost:8080/health', 30_000, 'libSQL');
    await waitForUrl('http://localhost:9000/minio/health/live', 30_000, 'MinIO');
    return await runHostTarget('mieweb', { mustPass: CORE.concat('vector') });
  } finally {
    if (keepInfra) {
      log('  --keep-infra: leaving docker compose stack running');
    } else {
      log('  tearing down docker compose…');
      spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v'], {
        cwd: composeDir,
        stdio: 'inherit',
      });
    }
  }
}

async function runCloudflare() {
  if (!commandExists('npx')) {
    return finishCf({ status: 'skip', reason: 'npx not available' });
  }
  const ver = spawnSync('npx', ['--no-install', 'wrangler', '--version'], { cwd: appDir });
  if (ver.status !== 0) {
    return finishCf({ status: 'skip', reason: 'wrangler not installed (npm i -D wrangler)' });
  }
  const port = PORTS.cf;
  const child = spawn(
    'npx',
    [
      '--no-install',
      'wrangler',
      'dev',
      '-c',
      'wrangler.local-dev.jsonc',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--var',
      'SKIP_SURFACES:vector,ai',
    ],
    { cwd: appDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const tail = captureTail(child);
  try {
    // Miniflare can take a while to compile + boot.
    await waitForHealth(`http://127.0.0.1:${port}`, 90_000, child, tail);
    const { passed, skipped } = await runSurfaceChecks(`http://127.0.0.1:${port}`, log);
    assertMustPass(passed, CORE);
    return { target: 'cf', status: 'pass', passed, skipped };
  } catch (err) {
    if (strictCf) throw err;
    return finishCf({ status: 'skip', reason: `wrangler dev did not come up: ${err.message}` });
  } finally {
    await stopProcess(child);
  }

  function finishCf(r) {
    return { target: 'cf', ...r };
  }
}

// --- helpers -------------------------------------------------------------

function readFlagValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function assertMustPass(passed, mustPass) {
  for (const surface of mustPass) {
    if (!passed.includes(surface)) {
      throw new Error(`surface "${surface}" did not pass`);
    }
  }
}

function commandExists(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', cmd], {
    shell: true,
  });
  return probe.status === 0;
}

function captureTail(child, max = 40) {
  const lines = [];
  const onData = (buf) => {
    for (const l of buf.toString().split('\n')) {
      if (l.trim()) lines.push(l);
    }
    while (lines.length > max) lines.shift();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return lines;
}

async function waitForUrl(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status === 404) return; // reachable
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label} at ${url}`);
}

async function waitForHealth(baseUrl, timeoutMs, child, tail) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server exited early:\n${(tail ?? []).join('\n')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${baseUrl}/health:\n${(tail ?? []).join('\n')}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const done = () => resolveStop();
    child.once('exit', done);
    child.kill('SIGINT');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    }, 4000);
    setTimeout(done, 8000);
  });
}

run().then((code) => process.exit(code));
