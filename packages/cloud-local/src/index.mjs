import { resolve } from 'node:path';
import { getDriver, registerDriver, driverNames } from './registry.mjs';

export { createSqliteD1 } from './adapters/d1-sqlite.mjs';
export { createSqliteVecIndex } from './adapters/vectorize-sqlitevec.mjs';
export { createFsBucket } from './adapters/r2-fs.mjs';
export { createMemoryKV } from './adapters/kv-memory.mjs';
export { createInprocQueue } from './adapters/queue-inproc.mjs';
export { createInprocNamespace } from './adapters/durable-inproc.mjs';
export { createAiBackend } from './adapters/ai-multi.mjs';
export { createUnsupportedBinding } from './adapters/unsupported.mjs';
export { registerDriver, getDriver, driverNames } from './registry.mjs';
export { applyMigrations } from './migrate.mjs';

/**
 * @typedef {object} LocalD1
 * @typedef {object} LocalBucket
 * @typedef {object} LocalKV
 * @typedef {object} LocalQueue
 * @typedef {object} LocalDurableNamespace
 * @typedef {(batch: any, env: any) => unknown} QueueConsumer
 */

/**
 * Build an `Env`-compatible object for a non-Cloudflare target from the
 * mieweb.jsonc adapter config. The result is duck-type compatible with the
 * app's `Env` interface, so the *same* worker handler runs against it.
 *
 * Late binding: queue producers must call back into the worker's `queue`
 * handler, and Durable Object namespaces must construct the worker's DO
 * classes — both of which live in the worker module the host imports *after*
 * the env exists. The host therefore passes accessors (`getQueueConsumer`,
 * `doClasses`) that resolve lazily.
 *
 * @param {object} args
 * @param {Record<string, any>} args.targetConfig  the `targets.<t>` block
 * @param {string} args.root  repo root (for resolving relative driver paths)
 * @param {string} [args.target]  target name (for error messages); default 'local'
 * @param {Record<string, unknown>} [args.vars]  wrangler `vars` to copy in
 * @param {() => QueueConsumer|undefined} [args.getQueueConsumer]
 * @param {Record<string, new (state: any, env: any) => any>} [args.doClasses]
 * @param {Record<string, any>} [args.services]  host-provided service handles (KV/Queue servers, …)
 * @returns {{ env: Record<string, any> }}
 */
export function createCloudEnv(args) {
  const {
    targetConfig,
    root,
    target = 'local',
    vars = {},
    getQueueConsumer = () => undefined,
    doClasses = {},
    services = {},
  } = args;
  const bindings = targetConfig.bindings ?? {};

  /** @type {Record<string, any>} */
  const env = {};

  // Public vars from wrangler.jsonc, then process.env for secrets/overrides.
  Object.assign(env, vars);
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  // Hold a reference so queue producers can read the finished env lazily.
  const getEnv = () => env;

  for (const [name, cfg] of Object.entries(bindings)) {
    const driverName = /** @type {{ driver: string }} */ (cfg).driver;
    const factory = getDriver(driverName);
    if (!factory) {
      console.warn(
        `[mieweb] unknown driver "${driverName}" for binding "${name}" — skipping. ` +
          `Known drivers: ${driverNames().join(', ')}`,
      );
      continue;
    }
    env[name] = factory({
      name,
      cfg,
      root,
      target,
      resolvePath: (/** @type {string} */ p) => resolve(root, p),
      getEnv,
      getQueueConsumer,
      doClasses,
      services,
    });
  }

  return { env };
}

/**
 * Await any async-constructed bindings (currently the SQLite D1 promise) so the
 * env is fully ready before the first request is served.
 * @param {Record<string, any>} env
 */
export async function settleEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v && typeof v.then === 'function') {
      // eslint-disable-next-line no-await-in-loop
      env[k] = await v;
    }
  }
  return env;
}
