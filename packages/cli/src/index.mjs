#!/usr/bin/env node
/**
 * `mieweb` — target-aware wrapper over wrangler.
 *
 *   mieweb dev
 *   mieweb deploy
 *   mieweb tail
 *   mieweb d1 migrations apply bluehive-hum
 *
 * On the `cloudflare` target (the default) most commands are forwarded verbatim
 * to the real `wrangler` binary. The deploy lifecycle verbs (`deploy`, `dev`,
 * `tail`, plus `login`/`logout`/`whoami`/`destroy`) instead run through a
 * pluggable deploy provider (`@mieweb/deploy-contract`); the Cloudflare
 * reference provider still drives `wrangler` underneath, adding config
 * injection, structured logging, resource reporting, and auth-aware errors.
 * Select another environment with `--target <t>` or `MIEWEB_TARGET=<t>`; those
 * commands are handled by the matching @mieweb adapter/provider instead.
 *
 * This file is plain ESM JavaScript on purpose so `mieweb` runs with bare
 * `node` — no build step, no transpiler, no extra runtime dependency.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { delegateToWrangler } from './cloudflare.mjs';
import { runHostTarget } from './local.mjs';
import { runInit } from './init.mjs';
import { runImagesCommand, runRegistryCommand } from './images.mjs';
import { resolveProvider, runProviderVerb } from './provider.mjs';

/** Verbs handled by the deploy-contract provider layer. */
const PROVIDER_VERBS = new Set(['deploy', 'dev', 'tail', 'login', 'logout', 'whoami', 'destroy']);

/** Read this CLI's version from its package.json. */
function miewebVersion() {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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

  // Version flags: always show the mieweb version first. On cloudflare we then
  // let wrangler print its own version below; other targets show mieweb only.
  if (args[0] === '--version' || args[0] === '-v' || args[0] === '-V') {
    process.stdout.write(`mieweb ${miewebVersion()}\n`);
  }

  // `init` scaffolds a NEW project, so it runs before config resolution (there
  // is no mieweb.jsonc to load yet) and is target-independent.
  if (args[0] === 'init') {
    return runInit(args.slice(1));
  }

  const config = loadConfig({ overrideTarget });

  // Container image plumbing (build once, skopeo copy — container-plan.md M2).
  // `images push` on the cloudflare target delegates to wrangler's managed
  // registry; every other target goes through skopeo to its own registry.
  if (args[0] === 'images') {
    if (config.target === 'cloudflare' && args[1] === 'push') {
      return delegateToWrangler(['containers', 'push', ...args.slice(2)], { cwd: config.root });
    }
    return runImagesCommand(args.slice(1), config).catch((err) => {
      console.error(err?.message ?? err);
      return 1;
    });
  }
  if (args[0] === 'registry') {
    return runRegistryCommand(args.slice(1), config).catch((err) => {
      console.error(err?.message ?? err);
      return 1;
    });
  }

  // Deploy-contract verbs route through a DeployProvider when one resolves for
  // the active target: deploy, dev, tail, login, logout, whoami, destroy (see
  // PROVIDER_VERBS). Cloudflare resolves to the wrangler reference provider;
  // other targets can name a provider package in mieweb.jsonc
  // (`targets[t].provider`). Everything else (d1 migrations, etc.) and any
  // target without a provider falls through to the legacy paths below.
  if (PROVIDER_VERBS.has(args[0])) {
    let provider = null;
    try {
      provider = await resolveProvider(config);
    } catch (err) {
      console.error(`mieweb: ${err?.message ?? err}`);
      return 1;
    }
    if (provider) {
      return runProviderVerb(
        /** @type {'deploy'|'dev'|'tail'|'login'|'logout'|'whoami'|'destroy'} */ (args[0]),
        provider,
        config,
        args.slice(1),
      );
    }
  }

  if (config.target === 'cloudflare') {
    // Reference path for non-provider commands: hand to wrangler untouched.
    return delegateToWrangler(args, { cwd: config.root });
  }

  // Node "host" targets run the unchanged worker via the host harness. `local`
  // uses the in-process adapters; `mieweb` (os.mieweb.org) uses the networked
  // ones (libSQL/S3/Valkey), registered when local.mjs imports @mieweb/cloud-adapters/os.
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
      '  mieweb init [dir]                   Scaffold a new mieweb project.',
      "  mieweb login                        Authenticate the active target's provider.",
      "  mieweb logout                       Clear the provider's stored session.",
      "  mieweb whoami                       Show the provider's auth status.",
      '  mieweb dev                          Start a dev server for the active target.',
      "  mieweb deploy                       Deploy via the active target's provider.",
      '  mieweb tail                         Stream logs from the deployed worker.',
      '  mieweb d1 migrations apply <db>     Apply ./migrations to the target DB.',
      '  mieweb images build|push|inspect|status   Build & skopeo-push container images.',
      '  mieweb registry login|logout        skopeo login to the target registry.',
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
