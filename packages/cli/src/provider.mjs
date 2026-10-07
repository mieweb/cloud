// @ts-check
import { pathToFileURL } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { resolve as resolveFrom } from 'import-meta-resolve';
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

/** CLI verbs that route through a DeployProvider (see runProviderVerb). */
export const PROVIDER_VERBS = /** @type {const} */ (['deploy', 'dev', 'tail', 'login', 'logout', 'whoami', 'destroy']);

/** @typedef {typeof PROVIDER_VERBS[number]} ProviderVerb */

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
  // A CommonJS provider's `module.exports` arrives as `default`.
  const factory = mod.createProvider ?? /** @type {any} */ (mod.default)?.createProvider;
  if (typeof factory === 'function') return factory(process.env);
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
    // Bare package specifier: resolve from the *project's* module graph, not
    // the CLI's own. ESM resolution first (`import` condition, so ESM-only
    // providers work), then CommonJS resolution (`require`-only providers).
    // Built-in providers are CLI dependencies, so if the project doesn't have
    // them, fall back to resolving from here.
    // (`import.meta.resolve`'s parent argument needs an experimental flag.)
    const parentUrl = pathToFileURL(join(config.root, 'package.json')).href;
    try {
      importable = resolveFrom(specifier, parentUrl);
    } catch {
      try {
        importable = pathToFileURL(createRequire(parentUrl).resolve(specifier)).href;
      } catch {
        importable = specifier;
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
 * `targets[t]` minus its data-plane `bindings` bag, which holds driver
 * settings (and possibly driver secrets) for the runtime adapters, not
 * deploy-provider config. Everything else in `targets[t]` is non-secret by
 * contract (credentials come from the environment via `createProvider(env)`)
 * and is passed through as-is.
 *
 * @param {Record<string, any>} [targetConfig]
 * @returns {Record<string, unknown>}
 */
function sanitizeTargetConfig(targetConfig) {
  const { bindings: _bindings, ...rest } = targetConfig ?? {};
  return rest;
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
 * @param {ProviderVerb} verb
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
      if (!provider.dev) return unsupported(context, provider, 'dev');
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
        ? handle.closed.then(() => 'closed')
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
      if (!provider.tail) return unsupported(context, provider, 'tail');
      await provider.tail(context);
      return 0;
    }

    if (verb === 'destroy') {
      if (!provider.destroy) return unsupported(context, provider, 'destroy');
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

    return unsupported(context, provider, verb);
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
 * @param {DeployContext} context
 * @param {DeployProvider} provider
 * @param {string} verb
 * @returns {number}
 */
function unsupported(context, provider, verb) {
  context.logger.error(`provider "${provider.name}" does not implement "${verb}".`);
  return 1;
}
