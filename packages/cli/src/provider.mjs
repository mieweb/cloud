// @ts-check
import { pathToFileURL } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

/**
 * Provider selection + context construction for the mieweb CLI.
 *
 * The CLI does not know *how* any target deploys — it delegates to a
 * `DeployProvider` (see `@mieweb/deploy-contract`). This module owns two things:
 *
 *   1. **Selection** — map the active target to a provider. Cloudflare uses the
 *      reference provider (`@mieweb/deploy-wrangler`); other targets may name a
 *      provider package in `mieweb.jsonc` (`targets[t].provider`), which we
 *      dynamically `import()`. The first provider whose `supports(target)`
 *      returns true wins.
 *   2. **Context** — project the CLI's internal `MiewebConfig` down to the
 *      neutral `DeployContext` the contract defines. Providers see only what
 *      they need, never the CLI's plumbing.
 *
 * Plain ESM + JSDoc (no build step); contract types referenced via `import()`.
 *
 * @typedef {import('@mieweb/deploy-contract').DeployProvider} DeployProvider
 * @typedef {import('@mieweb/deploy-contract').DeployContext} DeployContext
 * @typedef {import('@mieweb/deploy-contract').DeployProviderModule} DeployProviderModule
 * @typedef {import('./config.mjs').MiewebConfig} MiewebConfig
 */

/**
 * Built-in provider mapping. Kept tiny and explicit for the POC: only the
 * reference (cloudflare → wrangler) is wired in-repo. Other targets resolve
 * their provider dynamically from config (below), so opensource-server can ship
 * its provider as a separate package without a change here.
 *
 * @type {Record<string, string>}
 */
const BUILTIN_PROVIDERS = {
  cloudflare: '@mieweb/deploy-wrangler',
};

/**
 * Normalize a dynamically-imported module into a `DeployProvider`, honoring the
 * contract's `DeployProviderModule` convention (a `default` provider or a
 * `createProvider(env)` factory).
 *
 * @param {DeployProviderModule} mod
 * @param {string} specifier for diagnostics
 * @returns {DeployProvider}
 */
function toProvider(mod, specifier) {
  if (typeof mod.createProvider === 'function') return mod.createProvider(process.env);
  if (mod.default && typeof mod.default.deploy === 'function') return mod.default;
  throw new Error(
    `provider "${specifier}" does not export a DeployProvider ` +
      '(expected a `default` export or a `createProvider` factory).',
  );
}

/**
 * Resolve the provider for the active target.
 *
 * Resolution order:
 *   1. `mieweb.jsonc` → `targets[target].provider` (a package name or path).
 *   2. the built-in mapping (currently just cloudflare → wrangler).
 *
 * @param {MiewebConfig} config
 * @returns {Promise<DeployProvider|null>} the provider, or null if none applies
 */
export async function resolveProvider(config) {
  const configured =
    config.targetConfig && typeof config.targetConfig.provider === 'string'
      ? config.targetConfig.provider
      : undefined;
  const specifier = configured ?? BUILTIN_PROVIDERS[config.target];
  if (!specifier) return null;

  // Resolve the provider module. Two shapes:
  //   * a filesystem path (dev/local providers) → resolve against the project
  //     root (where mieweb.jsonc lives), NOT the process cwd, so running the CLI
  //     from a subdirectory still finds `./provider.mjs`.
  //   * a bare package specifier → resolve from the *project's* node_modules
  //     (rooted at config.root), NOT the CLI's own dependency tree, so a provider
  //     the consumer installed (e.g. `@mieweb/os-provider`) is found even when it
  //     isn't hoisted into the CLI's deps.
  let importable;
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    // Relative → resolve against project root; absolute (incl. Windows
    // `C:\...`) → use as-is. `resolve` handles both correctly.
    importable = pathToFileURL(resolve(config.root, specifier)).href;
  } else {
    // Bare package specifier: resolve from the *project's* module graph using
    // Node's ESM resolver (honors the `import` condition, so an ESM-only
    // provider resolves), rooted at the project's package.json — not the CLI's
    // own dependency tree. Fall back to a CLI-relative import only for the
    // built-in providers that ARE the CLI's deps (e.g. @mieweb/deploy-wrangler).
    const parentUrl = pathToFileURL(join(config.root, 'package.json')).href;
    try {
      importable = import.meta.resolve(specifier, parentUrl);
    } catch {
      try {
        // Secondary attempt via CJS resolver rooted at the project (covers
        // packages exposing only a `require`/`main` entry).
        const requireFromProject = createRequire(parentUrl);
        importable = pathToFileURL(requireFromProject.resolve(specifier)).href;
      } catch {
        importable = specifier; // last resort: CLI-relative (built-ins)
      }
    }
  }

  /** @type {DeployProviderModule} */
  const mod = await import(importable);
  const provider = toProvider(mod, specifier);

  if (!provider.supports(config.target)) {
    throw new Error(
      `provider "${provider.name}" (${specifier}) does not support target "${config.target}".`,
    );
  }
  return provider;
}

/**
 * Keys under `targets[t]` that hold **data-plane** configuration for the local
 * host harness / runtime adapters — NOT deploy-provider config. These can carry
 * driver secrets (`secretAccessKey`, `authToken`, …) and must never be handed to
 * a control-plane deploy provider, which the contract documents as receiving
 * only non-secret config. See packages/cli/mieweb-config.schema.json.
 */
const DATA_PLANE_KEYS = new Set(['bindings']);

/**
 * Matches key names that look secret-bearing. Because the config schema allows
 * arbitrary `targets.<t>` properties, a denylist of one bag (`bindings`) is not
 * enough: a custom `providerToken`/`password`/`accessKey` at the target level
 * would otherwise reach the provider. We drop any key whose name matches this,
 * as defense-in-depth on top of the `bindings` removal. Deploy credentials are
 * meant to come from the environment (`createProvider(env)`), never config.
 */
const SECRETISH_KEY = /(secret|token|password|passwd|credential|apikey|api_key|accesskey|access_key|privatekey|private_key|auth)/i;

/**
 * Recursively strip secret-bearing values from an arbitrary config value:
 *   - drops the data-plane `bindings` bag entirely,
 *   - drops any object key whose *name* looks secret-bearing ({@link SECRETISH_KEY}),
 *   - recurses into nested objects/arrays so a secret nested inside an otherwise
 *     non-secret setting (e.g. `registry.password`) is also removed.
 * Non-secret scalars/objects pass through. This upholds the contract's
 * guarantee that provider context is non-secret; deploy credentials come from
 * the environment via `createProvider(env)`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DATA_PLANE_KEYS.has(k) || SECRETISH_KEY.test(k)) continue;
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Project the raw per-target config down to what a deploy provider legitimately
 * needs: recursively redacted of the data-plane bags and any secret-bearing key,
 * keeping the open-ended non-secret config (provider name, instance URL, tuning,
 * …). Deploy credentials come from the environment via `createProvider(env)`.
 *
 * @param {Record<string, any>} [targetConfig]
 * @returns {Record<string, unknown>}
 */
function sanitizeTargetConfig(targetConfig) {
  return /** @type {Record<string, unknown>} */ (redactSecrets(targetConfig ?? {}));
}

/**
 * Non-secret top-level keys of `mieweb.jsonc` that are safe to expose to a
 * deploy provider. Allowlisted (not denylisted): the config schema permits
 * additional top-level properties, so an unknown key like `apiToken` must be
 * dropped rather than passed through. Deploy credentials live in the environment
 * (`createProvider(env)`), never in this context.
 */
const MIEWEB_PUBLIC_KEYS = new Set(['target', 'targets', 'wrangler']);

/**
 * Project the whole parsed `mieweb.jsonc` (`config.raw`) down to a non-secret
 * view for `DeployContext.mieweb`. Only allowlisted top-level keys survive, and
 * each `targets[*]` has its data-plane `bindings` bag (driver secrets) stripped —
 * otherwise sanitizing `targetConfig` alone would still leak secrets here.
 *
 * @param {Record<string, any>} [raw]
 * @returns {Record<string, unknown>}
 */
function sanitizeMieweb(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!MIEWEB_PUBLIC_KEYS.has(k)) continue; // drop unknown/secret top-level keys
    if (k !== 'targets') {
      out[k] = v;
      continue;
    }
    // Scrub each target's data-plane bags.
    /** @type {Record<string, unknown>} */
    const targets = {};
    for (const [t, cfg] of Object.entries(v ?? {})) {
      targets[t] =
        cfg && typeof cfg === 'object' ? sanitizeTargetConfig(/** @type {any} */ (cfg)) : cfg;
    }
    out.targets = targets;
  }
  return out;
}

/**
 * Decide the `manifestPath` to advertise on the context.
 *   - Explicitly configured (`mieweb.jsonc` → `wrangler` is a string): always
 *     pass it through, even if missing, so wrangler surfaces the error instead
 *     of silently discovering a different default.
 *   - Implicit default: pass it only when it exists; otherwise leave undefined
 *     so wrangler's own discovery runs.
 * @param {MiewebConfig} config
 * @returns {string|undefined}
 */
function resolveManifestPath(config) {
  const explicit = typeof config.raw?.wrangler === 'string';
  if (explicit) return config.wranglerPath || undefined;
  return config.wranglerPath && existsSync(config.wranglerPath) ? config.wranglerPath : undefined;
}

/**
 * Build the neutral {@link DeployContext} from the CLI's config + this
 * invocation's passthrough args + an abort signal wired to process interrupts.
 *
 * @param {MiewebConfig} config
 * @param {string[]} argv passthrough args (verb already removed)
 * @returns {{ context: DeployContext, dispose: () => void }}
 */
export function buildContext(config, argv) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  /** @type {DeployContext} */
  const context = {
    root: config.root,
    target: /** @type {any} */ (config.target),
    manifest: /** @type {Record<string, unknown>} */ (config.wrangler),
    // Advertise a manifest path when the user explicitly configured one (via
    // `mieweb.jsonc` → `wrangler`), even if missing, so wrangler reports it
    // rather than silently discovering a different default. For the IMPLICIT
    // default path, only advertise it when the file actually exists — otherwise
    // forwarding `--config <missing default>` would defeat wrangler's discovery.
    manifestPath: resolveManifestPath(config),
    mieweb: sanitizeMieweb(config.raw),
    targetConfig: sanitizeTargetConfig(config.targetConfig),
    argv,
    logger: {
      info: (m) => process.stderr.write(`[mieweb] ${m}\n`),
      warn: (m) => process.stderr.write(`[mieweb] WARN ${m}\n`),
      error: (m) => process.stderr.write(`[mieweb] ERROR ${m}\n`),
    },
    signal: controller.signal,
  };

  const dispose = () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  return { context, dispose };
}

/**
 * Drive a single deploy-contract verb through the resolved provider.
 *
 * Handles the provider verbs the CLI surfaces (`deploy`, `dev`, `tail`,
 * `login`, `logout`, `whoami`, `destroy`), mapping optional/absent verbs to a
 * clear "unsupported by provider" message — the control-plane analogue of
 * `UnsupportedBindingError`. {@link AuthError} is caught specially so the user
 * gets an actionable hint (e.g. "run `mieweb login`") instead of a raw failure.
 * Returns a process exit code.
 *
 * @param {'deploy'|'dev'|'tail'|'login'|'logout'|'whoami'|'destroy'} verb
 * @param {DeployProvider} provider
 * @param {MiewebConfig} config
 * @param {string[]} argv passthrough args (verb already removed)
 * @returns {Promise<number>}
 */
export async function runProviderVerb(verb, provider, config, argv) {
  const { context, dispose } = buildContext(config, argv);
  try {
    if (verb === 'deploy') {
      const result = await provider.deploy(context);
      reportDeploy(result);
      return 0;
    }

    if (verb === 'dev') {
      if (!provider.dev) return unsupported(provider, 'dev');
      const handle = await provider.dev(context);
      if (handle.url) context.logger.info(`dev server: ${handle.url}`);

      // Two ways this ends: (a) the user interrupts (signal aborts) → we stop the
      // handle; (b) the dev process exits on its own → `handle.closed` settles.
      // Race them so a crashed/finished dev returns instead of hanging forever.
      // Guard the already-aborted case: an aborted signal won't re-emit 'abort'
      // to a listener added afterwards, so check up front.
      const interrupted = new Promise((res) => {
        if (context.signal.aborted) return res('interrupt');
        context.signal.addEventListener('abort', () => res('interrupt'), { once: true });
      });
      const closed = handle.closed
        ? handle.closed.then(() => 'closed', (err) => { throw err; })
        : new Promise(() => {}); // provider can't self-exit → only interrupt ends it

      try {
        const how = await Promise.race([interrupted, closed]);
        if (how === 'interrupt') await handle.stop();
        return 0;
      } catch (err) {
        // dev process ended abnormally (non-zero/killed): stop the handle, then
        // let AuthError propagate to the outer handler so it gets the login-hint
        // treatment (parity with deploy/tail/login). Other errors are reported here.
        await handle.stop();
        if (/** @type {any} */ (err)?.name === 'AuthError') throw err;
        context.logger.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    if (verb === 'tail') {
      if (!provider.tail) return unsupported(provider, 'tail');
      await provider.tail(context);
      return 0;
    }

    if (verb === 'destroy') {
      if (!provider.destroy) return unsupported(provider, 'destroy');
      await provider.destroy(context);
      context.logger.info(`destroyed via provider "${provider.name}".`);
      return 0;
    }

    if (verb === 'login') {
      if (!provider.login) {
        context.logger.info(
          `provider "${provider.name}" takes credentials from the environment; ` +
            'there is nothing to log into. Set the appropriate credentials in your shell.',
        );
        return 0;
      }
      await provider.login(context);
      context.logger.info(`logged in via provider "${provider.name}".`);
      return 0;
    }

    if (verb === 'logout') {
      if (!provider.logout) {
        context.logger.info(
          `provider "${provider.name}" has no stored session to clear ` +
            '(credentials come from the environment).',
        );
        return 0;
      }
      await provider.logout(context);
      context.logger.info(`logged out of provider "${provider.name}".`);
      return 0;
    }

    if (verb === 'whoami') {
      if (!provider.whoami) {
        context.logger.info(
          `provider "${provider.name}" does not report auth status ` +
            '(it self-manages credentials via the environment).',
        );
        return 0;
      }
      const status = await provider.whoami(context);
      if (status.authenticated) {
        const who = status.account ? ` as ${status.account}` : '';
        const how = status.method ? ` (${status.method})` : '';
        process.stdout.write(`Authenticated${who}${how} — provider "${provider.name}".\n`);
        return 0;
      }
      process.stdout.write(`Not authenticated — provider "${provider.name}".\n`);
      return 1;
    }

    return unsupported(provider, verb);
  } catch (err) {
    // AuthError gets a friendlier, actionable message than a generic failure.
    // Its `message` already renders any provider-supplied hint, so we only add
    // the CLI's fallback "run login" nudge when the provider gave none.
    const authErr = /** @type {{ name?: string, hint?: string, message?: string }} */ (err);
    if (authErr && authErr.name === 'AuthError') {
      const nudge = authErr.hint ? '' : ` Run \`mieweb login --target ${config.target}\`.`;
      context.logger.error(`${authErr.message}${nudge}`);
      return 1;
    }
    context.logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    dispose();
  }
}

/**
 * Report a deploy result to the user, including any resource ids the provider
 * wants persisted back into the committed config.
 * @param {import('@mieweb/deploy-contract').DeployResult} result
 */
function reportDeploy(result) {
  if (result.url) process.stdout.write(`Deployed: ${result.url}\n`);
  const withIds = result.resources.filter((r) => r.id);
  if (withIds.length) {
    process.stdout.write('Resources:\n');
    for (const r of withIds) {
      process.stdout.write(`  ${r.binding} (${r.kind}): ${r.id}\n`);
    }
  }
}

/**
 * @param {DeployProvider} provider
 * @param {string} verb
 * @returns {number}
 */
function unsupported(provider, verb) {
  process.stderr.write(
    `[mieweb] provider "${provider.name}" does not implement "${verb}".\n`,
  );
  return 1;
}
