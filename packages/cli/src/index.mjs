#!/usr/bin/env node
/**
 * `mieweb` — target-aware wrapper over wrangler.
 *
 *   mieweb dev
 *   mieweb deploy
 *   mieweb tail
 *   mieweb d1 migrations apply bluehive-hum
 *
 * On the `cloudflare` target (the default) every command is forwarded
 * verbatim to the real `wrangler` binary, so Cloudflare behavior is identical
 * and nothing about the existing workflow changes. Select another environment
 * with `--target <t>` or `MIEWEB_TARGET=<t>`; those commands are handled by the
 * matching @mieweb adapter instead.
 *
 * This file is plain ESM JavaScript on purpose so `mieweb` runs with bare
 * `node` — no build step, no transpiler, no extra runtime dependency.
 */
import { loadConfig } from './config.mjs';
import { delegateToWrangler } from './cloudflare.mjs';
import { runHostTarget } from './local.mjs';

/** @param {string[]} argv */
async function main(argv) {
  // Pull a leading `--target <t>` / `--target=<t>` out of the arg list before
  // it reaches wrangler (which wouldn't understand it).
  let overrideTarget = null;
  /** @type {string[]} */
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target' || a === '-t') {
      overrideTarget = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a.startsWith('--target=')) {
      overrideTarget = a.slice('--target='.length);
      continue;
    }
    args.push(a);
  }

  if (args[0] === 'help' || args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return 0;
  }

  const config = loadConfig({ overrideTarget });

  if (config.target === 'cloudflare') {
    // Reference path: hand everything to wrangler untouched.
    return delegateToWrangler(args, { cwd: config.root });
  }

  // Node "host" targets run the unchanged worker via the host harness. `local`
  // uses the in-process adapters; `mieweb` (os.mieweb.org) uses the networked
  // ones (libSQL/S3/Valkey), registered when local.mjs imports @mieweb/cloud-os.
  if (config.target === 'local' || config.target === 'mieweb') {
    return runHostTarget(args, config);
  }

  console.error(
    `mieweb: target "${config.target}" has no adapter yet. ` +
      `Supported today: cloudflare (delegates to wrangler), local + mieweb (Node host harness).`,
  );
  return 1;
}

function printHelp() {
  process.stdout.write(
    [
      'mieweb — target-aware wrapper over wrangler',
      '',
      'Usage:',
      '  mieweb [--target <cloudflare|local|mieweb>] <command> [...args]',
      '',
      'Targets:',
      '  cloudflare (default)  Forward the command verbatim to wrangler.',
      '  local                 Run against the local Node host harness / adapters.',
      '  mieweb                Run against os.mieweb.org adapters (libSQL/S3/Valkey).',
      '',
      'Common commands:',
      '  mieweb dev                          Start a dev server for the active target.',
      '  mieweb deploy                       Deploy (cloudflare only).',
      '  mieweb tail                         Stream logs (cloudflare only).',
      '  mieweb d1 migrations apply <db>     Apply ./migrations to the target DB.',
      '',
      'Selecting a target:',
      '  mieweb --target local dev           Flag form.',
      '  mieweb --target mieweb dev          Run the os.mieweb.org adapters.',
      '  MIEWEB_TARGET=local mieweb dev      Env form.',
      '  (or set "target" in mieweb.jsonc)',
      '',
      'Escape hatch:',
      '  MIEWEB_REAL_WRANGLER=/path/to/wrangler mieweb deploy',
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
