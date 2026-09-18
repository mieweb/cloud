// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AuthError } from '@mieweb/deploy-contract';
import { parseJsonc } from '@mieweb/deploy-contract/jsonc';

/**
 * `@mieweb/deploy-wrangler` — the Cloudflare **reference** deploy provider.
 *
 * Implements `DeployProvider` from `@mieweb/deploy-contract` by delegating to
 * the real `wrangler` binary. Cloudflare is the reference implementation of the
 * portability layer, so this provider does the least translation possible:
 * `deploy`/`dev`/`tail` shell out to wrangler verbatim, and resource identity is
 * read straight back out of the wrangler.jsonc manifest (wrangler itself owns
 * provisioning + write-back).
 *
 * Every other provider (opensource-server, future AWS/GCP) is measured against
 * this one via the contract's conformance test-kit.
 *
 * Authored as plain ESM with JSDoc types (no build step) to match the rest of
 * the mieweb CLI tooling. This file opts into `// @ts-check` (top of file) so
 * `tsc --noEmit` type-checks the JSDoc against `@mieweb/deploy-contract` —
 * despite the repo's global `checkJs: false` — catching drift from
 * `DeployProvider`.
 *
 * @typedef {import('@mieweb/deploy-contract').DeployProvider} DeployProvider
 * @typedef {import('@mieweb/deploy-contract').DeployContext} DeployContext
 * @typedef {import('@mieweb/deploy-contract').DeployResult} DeployResult
 * @typedef {import('@mieweb/deploy-contract').DeployHandle} DeployHandle
 * @typedef {import('@mieweb/deploy-contract').ResourceHandle} ResourceHandle
 * @typedef {import('@mieweb/deploy-contract').ResourceKind} ResourceKind
 * @typedef {import('@mieweb/deploy-contract').DeployTarget} DeployTarget
 */

/**
 * Max bytes of captured stderr retained (a bounded suffix). The capture buffer
 * is only used to classify an eventual auth failure, so long-running commands
 * (`tail`) must not accumulate it unbounded. 64 KiB comfortably holds any
 * wrangler auth message.
 */
const STDERR_CAP = 64 * 1024;

/**
 * Spawn the repo-pinned `wrangler` and resolve with its exit status.
 *
 * Resolution order mirrors the CLI's existing delegation: an explicit
 * `MIEWEB_REAL_WRANGLER` escape hatch first, otherwise a detected package runner
 * (npm/pnpm/yarn/bun — see {@link resolveRunner}) so the project's wrangler is
 * used even when it isn't on PATH. Output is inherited so wrangler's own UX
 * (prompts, colors, progress) is preserved untouched.
 *
 * With `capture: true`, stderr is additionally teed into an in-memory buffer and
 * returned as `stderr` — used to classify failures (e.g. auth errors) without
 * losing the live terminal output. Capture is automatically **disabled when
 * stderr is a TTY**, so interactive `deploy`/`dev`/`tail` keep wrangler's native
 * colors, progress, and prompts (near-verbatim delegation); classification then
 * relies on exit codes and the user sees wrangler's own message.
 *
 * Resolves with the raw exit `code` **and** any terminating `signal`: a child
 * killed by a signal reports `code === null`, which callers must treat as
 * failure rather than success (see {@link assertOk}).
 *
 * @param {string[]} args wrangler argv
 * @param {{ cwd: string, signal: AbortSignal, capture?: boolean }} opts
 * @returns {Promise<{ code: number|null, signal: NodeJS.Signals|null, stderr: string }>}
 */
function runWrangler(args, opts) {
  const real = process.env.MIEWEB_REAL_WRANGLER;
  if (!real) {
    // Using a package runner (npx/pnpm/…) to launch the project's wrangler: the
    // runner itself exists, so a missing wrangler surfaces as a generic non-zero
    // exit rather than spawn ENOENT. Pre-resolve wrangler from the project so we
    // can raise the actionable prerequisite error instead.
    if (!wranglerResolvable(opts.cwd)) {
      return Promise.reject(
        new Error(
          'wrangler binary not found. Install it as a dependency of your project ' +
            '(`npm i -D wrangler`) or set MIEWEB_REAL_WRANGLER to its path.',
        ),
      );
    }
  }
  const { cmd, prefix } = real ? { cmd: real, prefix: [] } : resolveRunner();
  const finalArgs = [...prefix, ...args];
  // Capture stderr only when requested AND stderr is not a TTY. On a TTY,
  // piping would flip wrangler's own `isTTY` detection (changing its colors,
  // progress, and prompts), so we must inherit and leave `stderr` empty — the
  // caller then falls back to a whoami probe for auth classification. In
  // non-interactive/CI runs stderr is already a pipe, so capturing changes
  // nothing the user perceives and lets us classify from the verb's own output.
  const capture = opts.capture === true && !process.stderr.isTTY;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, finalArgs, {
      cwd: opts.cwd,
      stdio: capture ? ['inherit', 'inherit', 'pipe'] : 'inherit',
      signal: opts.signal,
    });
    let stderr = '';
    if (capture && child.stderr) {
      child.stderr.on('data', (chunk) => {
        // Keep only a bounded suffix: the buffer exists solely to classify an
        // eventual auth failure, so an unbounded accumulation would leak memory
        // on long-running commands (e.g. `tail`). CAP is generous enough to
        // retain any auth message while staying constant-space.
        stderr = (stderr + chunk).slice(-STDERR_CAP);
        // Tee: keep wrangler's live output on the terminal. This is the child's
        // own output under the contract's subprocess-stdio exception (see
        // DeployLogger docs), not provider-authored logging.
        process.stderr.write(chunk);
      });
    }
    child.on('error', (/** @type {any} */ err) => {
      // ENOENT here means neither MIEWEB_REAL_WRANGLER nor a resolvable
      // `wrangler` exists — surface an actionable prerequisite message.
      if (err && err.code === 'ENOENT') {
        reject(
          new Error(
            'wrangler binary not found. Install it as a dependency of your project ' +
              '(`npm i -D wrangler`) or set MIEWEB_REAL_WRANGLER to its path.',
          ),
        );
        return;
      }
      reject(err);
    });
    // Resolve on `close`, not `exit`: `close` fires only after the child's
    // stdio streams have fully flushed, so a captured stderr buffer is complete
    // (an auth message can otherwise arrive after `exit` and be missed).
    child.on('close', (code, signal) => resolvePromise({ code, signal, stderr }));
  });
}

/**
 * Pick a package runner to launch the project's local `wrangler` when no
 * `MIEWEB_REAL_WRANGLER` override is given. We honor `npm_config_user_agent`
 * (set by the active package manager) so an npm-only consumer isn't forced to
 * have pnpm installed, then fall back to `npx` which ships with Node.
 * @returns {{ cmd: string, prefix: string[] }}
 */
function resolveRunner() {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return { cmd: 'pnpm', prefix: ['exec', 'wrangler'] };
  if (ua.startsWith('yarn')) return { cmd: 'yarn', prefix: ['wrangler'] };
  if (ua.startsWith('bun')) return { cmd: 'bun', prefix: ['x', 'wrangler'] };
  // npm and the generic case: npx resolves a local (or fetched) wrangler and is
  // always present with Node.
  return { cmd: 'npx', prefix: ['--no-install', 'wrangler'] };
}

/**
 * Whether `wrangler` is resolvable from the project at `cwd` (so a package
 * runner will actually find it). Used to raise an actionable prerequisite error
 * before spawning a runner that would otherwise fail with a generic non-zero
 * exit when wrangler isn't installed.
 * @param {string} cwd project directory
 * @returns {boolean}
 */
function wranglerResolvable(cwd) {
  const req = createRequire(pathToFileURL(join(cwd, 'package.json')).href);
  for (const spec of ['wrangler/package.json', 'wrangler']) {
    try {
      req.resolve(spec);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

/**
 * Throw a consistent error unless wrangler exited cleanly with code 0. A
 * `null` code (child terminated by a signal, e.g. SIGKILL/SIGTERM) is a
 * failure, not a success — mapping it to 0 would let a killed deploy/login
 * report success.
 *
 * @param {{ code: number|null, signal: NodeJS.Signals|null }} result
 * @param {string} verb for the message
 */
function assertOk(result, verb) {
  if (result.code === 0) return;
  if (result.signal) {
    throw new Error(`wrangler ${verb} was terminated by signal ${result.signal}`);
  }
  throw new Error(`wrangler ${verb} exited with code ${result.code}`);
}

/** Exit codes wrangler uses when the caller is unauthenticated/forbidden. */
const AUTH_EXIT_HINT =
  'run `wrangler login`, or set CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) in your environment';

/**
 * Build wrangler's `--config <path>` flag from the context's resolved manifest
 * path, so a project whose canonical manifest lives at a custom location is
 * deployed (and reloaded) correctly. Empty when no path is known (wrangler then
 * uses its own discovery) OR when the user already passed their own `--config`
 * in argv — in which case we must not add a second, conflicting flag.
 * @param {DeployContext} context
 * @returns {string[]}
 */
function configFlag(context) {
  if (userConfigPath(context.argv) !== null) return []; // user supplied one
  return context.manifestPath ? ['--config', context.manifestPath] : [];
}

/**
 * Extract a user-supplied wrangler config path from passthrough argv, if any
 * (`--config <p>`, `--config=<p>`, `-c <p>`). Returns the path, or null when the
 * user did not specify one.
 * @param {readonly string[]} argv
 * @returns {string|null}
 */
function userConfigPath(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config' || a === '-c') return argv[i + 1] ?? '';
    if (a.startsWith('--config=')) return a.slice('--config='.length);
  }
  return null;
}

/**
 * The manifest path to reload after a deploy: the user's `--config` if they
 * supplied one (resolved against root), else the context's manifest path.
 * Ensures reported resource handles come from the manifest actually deployed.
 * @param {DeployContext} context
 * @returns {string|undefined}
 */
function effectiveManifestPath(context) {
  const user = userConfigPath(context.argv);
  if (user) return isAbsolute(user) ? user : join(context.root, user);
  return context.manifestPath;
}

/**
 * Heuristically decide whether captured wrangler stderr indicates a genuine
 * authentication/authorization failure (as opposed to a network, config, or
 * resource error). We look for explicit markers so we only steer the user to
 * `mieweb login` when that is actually the problem.
 * @param {string} stderr
 * @returns {boolean}
 */
function isAuthFailure(stderr) {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes('[code: 10000]') || // wrangler: Authentication error
    /\b(401|403)\b/.test(s) ||
    s.includes('unauthorized') ||
    s.includes('not authenticated') ||
    s.includes('authentication error') ||
    s.includes('please run `wrangler login`') ||
    s.includes('you are not authenticated')
  );
}

/**
 * Decide whether a failed `deploy`/`dev`/`tail` was an authentication/permission
 * failure, so the CLI can offer the login hint.
 *
 * Authority order:
 *   1. **The verb's own captured stderr** (present in non-interactive/CI runs,
 *      where we can capture without harming wrangler's UX). An explicit auth
 *      marker there — including 401/403 for a valid-but-unauthorized token — is
 *      the definitive signal.
 *   2. **A strict `whoami` probe**, used only when the verb's stderr was not
 *      captured (interactive TTY). It classifies as auth *only* on an explicit
 *      not-authenticated marker from whoami — never on an empty stderr or a bare
 *      non-zero exit, so an ambiguous/network whoami failure does not get
 *      mislabeled as auth. (This path cannot see operation-level 403s when the
 *      token is otherwise valid; those are reported generically rather than
 *      guessed.)
 *
 * @param {DeployContext} context
 * @param {{ stderr: string }} result the failed verb's result
 * @returns {Promise<boolean>}
 */
async function failedDueToAuth(context, result) {
  // 1. Prefer the verb's own output when we have it (captures 401/403 including
  //    valid-token-but-forbidden, which a whoami probe cannot see).
  if (result.stderr && result.stderr.trim() !== '') {
    return isAuthFailure(result.stderr);
  }
  // 2. Interactive TTY: the verb's stderr wasn't captured. Probe whoami, but
  //    only trust an *explicit* not-authenticated marker.
  try {
    const who = await runWrangler(['whoami'], {
      cwd: context.root,
      signal: context.signal,
      capture: true,
    });
    if (who.code === 0) return false; // clearly authenticated
    return isAuthFailure(who.stderr); // explicit marker only; no empty fallback
  } catch {
    return false; // couldn't probe → don't mislabel
  }
}

/**
 * Read the resources declared in a wrangler manifest as neutral
 * {@link ResourceHandle}s. On Cloudflare, identity lives in wrangler's native
 * fields (`database_id`, `bucket_name`, `id`, …); after a successful deploy the
 * committed manifest is authoritative, so we surface whatever ids are present.
 * Entries still missing an id (freshly auto-provisioned, not yet written back)
 * are reported with an empty id — the contract permits it, and the reference
 * flow leaves persistence to wrangler/the user committing the file.
 *
 * @param {Readonly<Record<string, unknown>>} manifest
 * @returns {ResourceHandle[]}
 */
function readResources(manifest) {
  /** @type {ResourceHandle[]} */
  const out = [];
  /**
   * @param {string} key manifest array key
   * @param {ResourceKind} kind neutral kind
   * @param {string} idField wrangler's identity field for this kind
   */
  const collect = (key, kind, idField) => {
    const arr = manifest[key];
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue;
      const binding = entry.binding ?? entry.name;
      if (typeof binding !== 'string') continue;
      out.push({ binding, kind, id: typeof entry[idField] === 'string' ? entry[idField] : '' });
    }
  };

  collect('d1_databases', 'database', 'database_id');
  collect('r2_buckets', 'bucket', 'bucket_name');
  collect('kv_namespaces', 'kv', 'id');
  collect('vectorize', 'vector', 'index_name');
  // Note: the AI binding (`ai: { binding: "AI" }`) is intentionally omitted.
  // It is an object, not an array, and Workers AI is not provisioned per-app —
  // there is no backend resource id to report, and the binding name is not one.

  // Queue *producers* live under `queues.producers`, each with a `binding` and
  // a `queue` (the queue name = its identity).
  const queues = /** @type {any} */ (manifest.queues);
  if (queues && typeof queues === 'object' && Array.isArray(queues.producers)) {
    for (const p of queues.producers) {
      if (p && typeof p === 'object' && typeof p.binding === 'string') {
        out.push({ binding: p.binding, kind: 'queue', id: typeof p.queue === 'string' ? p.queue : '' });
      }
    }
  }

  return out;
}

/**
 * Re-read the manifest from disk after a deploy. When wrangler auto-provisions a
 * resource it writes the new id back into the on-disk `wrangler.jsonc`; the
 * in-memory {@link DeployContext.manifest} was parsed *before* the deploy and is
 * stale, so reading ids from it would miss freshly-created resources. We reload
 * the file so surfaced {@link ResourceHandle}s carry the written-back ids.
 *
 * Uses {@link DeployContext.manifestPath} (the resolved path, honoring a custom
 * location) when present, falling back to the conventional filenames under
 * {@link DeployContext.root}. Best-effort: if the file can't be found/parsed we
 * fall back to the in-memory manifest rather than fail the deploy — the deploy
 * already succeeded.
 *
 * @param {DeployContext} context
 * @returns {Readonly<Record<string, unknown>>}
 */
function reloadManifest(context) {
  const effective = effectiveManifestPath(context);
  const candidates = effective
    ? [effective]
    : [join(context.root, 'wrangler.jsonc'), join(context.root, 'wrangler.json')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return /** @type {Record<string, unknown>} */ (parseJsonc(readFileSync(p, 'utf8')));
    } catch {
      break;
    }
  }
  return context.manifest;
}

/**
 * The reference provider instance. Stateless — safe to share.
 * @type {DeployProvider}
 */
export const wranglerProvider = {
  name: 'wrangler',

  /**
   * The reference provider owns the `cloudflare` target only. Other targets are
   * served by their own providers.
   * @param {DeployTarget} target
   */
  supports(target) {
    return target === 'cloudflare';
  },

  /**
   * Deploy by delegating to `wrangler deploy`. wrangler reads the manifest,
   * ensures resources exist (native provisioning), and pushes the worker; we
   * then reload the (possibly written-back) manifest and surface its resources
   * as neutral handles. Idempotent because wrangler's own deploy is.
   *
   * A genuine auth failure (explicit 401/403 / "not authenticated" in wrangler's
   * output) is mapped to {@link AuthError} so the CLI can offer the login hint.
   * We only translate *explicitly identified* auth errors: other non-zero exits
   * (network, config, resource errors) preserve the original deploy failure so
   * we don't mislead the user into re-authenticating.
   * @param {DeployContext} context
   * @returns {Promise<DeployResult>}
   */
  async deploy(context) {
    context.logger.info('wrangler: deploying via the pinned wrangler binary');
    // Request capture: honored only in non-TTY (CI), where the verb's own stderr
    // becomes the authoritative auth signal; on a TTY it inherits and we fall
    // back to a whoami probe. Either way TTY UX is preserved.
    const result = await runWrangler(['deploy', ...configFlag(context), ...context.argv], {
      cwd: context.root,
      signal: context.signal,
      capture: true,
    });
    if (result.code !== 0) {
      if (await failedDueToAuth(context, result)) {
        throw new AuthError('wrangler', context.target, AUTH_EXIT_HINT);
      }
      assertOk(result, 'deploy');
    }
    // wrangler may have written new ids back into wrangler.jsonc; read those.
    const resources = readResources(reloadManifest(context));
    context.logger.info(`wrangler: deploy complete (${resources.length} resource binding(s))`);
    return { resources };
  },

  /**
   * Start `wrangler dev`. wrangler stays in the foreground until interrupted; we
   * bridge that to the contract's {@link DeployHandle}. The handle's `closed`
   * promise resolves/rejects when the child exits on its own (crash, or the user
   * quitting wrangler), so the CLI can stop waiting instead of hanging.
   * @param {DeployContext} context
   * @returns {Promise<DeployHandle>}
   */
  async dev(context) {
    const controller = new AbortController();
    // Fold the caller's signal into ours so either can stop the child. Handle an
    // already-aborted incoming signal too (don't miss the event).
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const done = runWrangler(['dev', ...configFlag(context), ...context.argv], {
      cwd: context.root,
      signal: controller.signal,
      capture: true,
    }).then(
      async (result) => {
        // A clean exit (code 0) or a stop()-triggered abort is fine; anything
        // else is a dev failure the CLI should learn about via `closed`.
        if (result.code === 0 || controller.signal.aborted) return;
        // Classify: the verb's own stderr (CI) or a whoami probe (TTY).
        if (await failedDueToAuth(context, result)) {
          throw new AuthError('wrangler', context.target, AUTH_EXIT_HINT);
        }
        throw new Error(
          result.signal
            ? `wrangler dev was terminated by signal ${result.signal}`
            : `wrangler dev exited with code ${result.code}`,
        );
      },
      (err) => {
        if (/** @type {any} */ (err)?.name === 'AbortError') return; // expected on stop()
        throw err;
      },
    );

    context.logger.info('wrangler: dev server started');
    return {
      closed: done,
      stop() {
        controller.abort();
        return done.catch(() => undefined);
      },
    };
  },

  /**
   * Stream logs via `wrangler tail`. This is an interactive, long-running
   * command: a user Ctrl-C is normal termination and returns success (like
   * {@link dev}), not an error. Genuine child failures still throw, and an
   * explicit auth failure is translated to {@link AuthError} for the login hint.
   * @param {DeployContext} context
   */
  async tail(context) {
    let result;
    try {
      result = await runWrangler(['tail', ...configFlag(context), ...context.argv], {
        cwd: context.root,
        signal: context.signal,
        capture: true,
      });
    } catch (err) {
      // The caller interrupted (Ctrl-C) → aborting the child surfaces as
      // AbortError. For an interactive stream that is a clean stop, not a failure.
      if (/** @type {any} */ (err)?.name === 'AbortError' && context.signal.aborted) return;
      throw err;
    }
    // A signal stop we initiated via context.signal is also a clean exit.
    if (context.signal.aborted) return;
    if (result.code !== 0 && (await failedDueToAuth(context, result))) {
      throw new AuthError('wrangler', context.target, AUTH_EXIT_HINT);
    }
    assertOk(result, 'tail');
  },

  /**
   * Report auth status via `wrangler whoami`. We classify the result rather than
   * treating every non-zero exit as "not authenticated": only an explicit auth
   * failure yields `authenticated: false`. Other failures (network/DNS, config,
   * signal kill) throw, so the CLI surfaces "status could not be determined"
   * instead of falsely claiming the user is logged out.
   * @param {DeployContext} context
   * @returns {Promise<import('@mieweb/deploy-contract').AuthStatus>}
   */
  async whoami(context) {
    const result = await runWrangler(['whoami', ...context.argv], {
      cwd: context.root,
      signal: context.signal,
      capture: true,
    });
    if (result.code === 0) {
      // Env-token auth vs. the OAuth cache both satisfy wrangler; report the
      // dominant method for diagnostics without asserting which one wrangler used.
      const method = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY ? 'env' : 'oauth';
      return { authenticated: true, method };
    }
    // Non-zero: only an explicit auth signal means "logged out".
    if (isAuthFailure(result.stderr)) {
      return { authenticated: false };
    }
    // Anything else (signal kill, network, config) is an *undetermined* status.
    if (result.signal) {
      throw new Error(`wrangler whoami was terminated by signal ${result.signal}`);
    }
    throw new Error(
      `wrangler whoami could not determine auth status (exited with code ${result.code})`,
    );
  },

  /**
   * Authenticate via `wrangler login` (interactive browser OAuth). Inherits
   * stdio so wrangler's prompts/redirect flow work unchanged. A non-zero exit
   * (or a signal kill) means the flow was declined or failed.
   * @param {DeployContext} context
   */
  async login(context) {
    context.logger.info('wrangler: starting interactive login (browser OAuth)');
    let result;
    try {
      result = await runWrangler(['login', ...context.argv], {
        cwd: context.root,
        signal: context.signal,
      });
    } catch (err) {
      // Ctrl-C during the interactive flow aborts the child (AbortError); treat
      // that as a cancelled login, consistent with the non-zero-exit path.
      if (/** @type {any} */ (err)?.name === 'AbortError' && context.signal.aborted) {
        throw new AuthError('wrangler', context.target, 'wrangler login was cancelled');
      }
      throw err;
    }
    if (result.code !== 0) {
      throw new AuthError('wrangler', context.target, 'wrangler login was cancelled or failed');
    }
  },

  /**
   * Clear the cached OAuth session via `wrangler logout`. Note this does not
   * (and cannot) unset `CLOUDFLARE_API_TOKEN`-style env credentials — those are
   * host-injected and outside wrangler's control; we surface that as a warning.
   * @param {DeployContext} context
   */
  async logout(context) {
    if (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY) {
      context.logger.warn(
        'wrangler: environment credentials (CLOUDFLARE_API_TOKEN/KEY) are set and ' +
          'take precedence — unset them in your shell to fully log out.',
      );
    }
    const result = await runWrangler(['logout', ...context.argv], {
      cwd: context.root,
      signal: context.signal,
    });
    assertOk(result, 'logout');
  },
};

/**
 * Factory form of the provider, per the contract's `DeployProviderModule`
 * convention. Ignores `env` — the reference provider takes its configuration
 * from wrangler.jsonc/PATH, not host env vars (beyond the
 * `MIEWEB_REAL_WRANGLER` escape hatch read at spawn time).
 *
 * @param {import('@mieweb/deploy-contract').ProviderEnv} [_env]
 * @returns {DeployProvider}
 */
export function createProvider(_env) {
  return wranglerProvider;
}

export default wranglerProvider;
