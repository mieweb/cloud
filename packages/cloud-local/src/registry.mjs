import { resolve } from 'node:path';
import { createSqliteD1 } from './adapters/d1-sqlite.mjs';
import { createSqliteVecIndex } from './adapters/vectorize-sqlitevec.mjs';
import { createFsBucket } from './adapters/r2-fs.mjs';
import { createMemoryKV } from './adapters/kv-memory.mjs';
import { createInprocQueue } from './adapters/queue-inproc.mjs';
import { createInprocNamespace } from './adapters/durable-inproc.mjs';
import { createUnsupportedBinding } from './adapters/unsupported.mjs';

/**
 * Driver registry — the single extension point for the portability layer.
 *
 * A *driver* turns one binding's config (`{ driver, ...opts }` from
 * `mieweb.jsonc`) into a live, Cloudflare-shaped binding object (a `CloudKV`,
 * `CloudBucket`, `CloudQueue`, …). `createCloudEnv` just looks the driver up
 * here and calls it — so adding a new backend (sqlite-vec, artipod, redis, an
 * `os`/`aws` service) is a `registerDriver()` call, never a core edit.
 *
 * A factory receives a {@link DriverContext} and returns the binding (sync) or
 * a promise for it (async constructors like SQLite are awaited by `settleEnv`).
 *
 * @typedef {object} DriverContext
 * @property {string} name      the binding name (e.g. 'DB', 'SESSIONS')
 * @property {Record<string, any>} cfg  this binding's config block
 * @property {string} root      repo root (for resolving relative paths)
 * @property {string} target    the active target (for diagnostics/errors)
 * @property {(p: string) => string} resolvePath  resolve a cfg path against root
 * @property {() => Record<string, any>} getEnv   late-bound finished Env
 * @property {() => (import('./index.mjs').QueueConsumer|undefined)} getQueueConsumer
 * @property {Record<string, new (state: any, env: any) => any>} doClasses
 * @property {Record<string, any>} services  host-provided service handles (KV/Queue servers, …)
 *
 * @typedef {(ctx: DriverContext) => any} DriverFactory
 */

/** @type {Map<string, DriverFactory>} */
const registry = new Map();

/**
 * Register (or override) a driver factory by name.
 * @param {string} name
 * @param {DriverFactory} factory
 */
export function registerDriver(name, factory) {
  registry.set(name, factory);
}

/**
 * Look up a driver factory.
 * @param {string} name
 * @returns {DriverFactory|undefined}
 */
export function getDriver(name) {
  return registry.get(name);
}

/** @returns {string[]} the registered driver names */
export function driverNames() {
  return [...registry.keys()];
}

// --- Built-in drivers (the local POC set) -------------------------------
// Each wraps an existing adapter. Cloudflare itself never uses these — it runs
// the native bindings directly — so this set only matters off-Cloudflare.

registerDriver('sqlite', ({ cfg, resolvePath }) => createSqliteD1(resolvePath(cfg.path)));

registerDriver('sqlite-vec', ({ cfg, resolvePath }) =>
  createSqliteVecIndex(resolvePath(cfg.path), { dim: cfg.dim ?? 768 }),
);

registerDriver('fs', ({ cfg, resolvePath }) => createFsBucket(resolvePath(cfg.path)));

registerDriver('memory', () => createMemoryKV());

registerDriver('inproc', ({ name, cfg, getQueueConsumer, getEnv, doClasses }) => {
  if (cfg.queue) {
    return createInprocQueue(cfg.queue, getQueueConsumer, getEnv);
  }
  // Otherwise this is a Durable Object namespace; class is wired via doClasses.
  return createInprocNamespace(
    name,
    () => {
      const Klass = doClasses[name];
      if (!Klass) {
        throw new Error(`[mieweb] no DO class registered for binding "${name}"`);
      }
      return Klass;
    },
    getEnv,
  );
});

registerDriver('unsupported', ({ name, target }) => createUnsupportedBinding(name, target));

/**
 * Resolve a path from a binding's config against the repo root.
 * @param {string} root
 * @param {string} p
 */
export function resolveAgainst(root, p) {
  return resolve(root, p);
}
