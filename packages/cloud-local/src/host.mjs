import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createCloudEnv, settleEnv } from './index.mjs';

/**
 * Node host harness: runs the **unchanged** worker handler off Cloudflare.
 *
 * Flow:
 *   1. Dynamically import the worker entry (its `main` from wrangler.jsonc).
 *      The entry's `export default { fetch, queue, scheduled }` is the same
 *      object Cloudflare invokes, and it re-exports the Durable Object classes.
 *   2. Build an `Env` from mieweb.jsonc via `createCloudEnv`, wiring the DO
 *      classes and the worker's own `queue` handler back in (late-bound).
 *   3. Serve `worker.fetch(request, env, ctx)` over HTTP with
 *      `@hono/node-server`, and tick `worker.scheduled(...)` on the cron
 *      cadence so background jobs run locally too.
 *
 * NOTE: importing a production worker under Node depends on it not touching
 * Cloudflare-only globals at module-eval time. The portable bindings, the
 * `mieweb:workers` shim, and queue/DO/cron wiring are handled here; any
 * remaining Cloudflare-global usage at import time is the one place app code
 * may still need a small guard. This is the documented edge of the POC.
 *
 * @param {object} args
 * @param {import('../../cli/src/config.mjs').MiewebConfig|any} args.config
 * @param {string[]} [args.doBindings] DO binding names to register
 * @returns {Promise<{ port: number, stop: () => void }>}
 */
export async function startLocalHost({ config }) {
  const root = config.root;
  const wrangler = config.wrangler ?? {};
  const targetConfig = config.targetConfig ?? {};
  const mainRel = typeof wrangler.main === 'string' ? wrangler.main : 'worker/index.ts';
  const mainUrl = pathToFileURL(resolve(root, mainRel)).href;

  // 1. Import the worker entry (TS). Requires a TS-capable loader (tsx / node
  //    type stripping); the CLI launches us with one.
  const workerMod = await import(mainUrl);
  const handler = workerMod.default ?? workerMod;

  // Discover DO classes the worker re-exports (CallSession, SmsConversation…).
  /** @type {Record<string, new (s: any, e: any) => any>} */
  const exportedClasses = {};
  for (const [k, v] of Object.entries(workerMod)) {
    if (typeof v === 'function' && /^[A-Z]/.test(k)) exportedClasses[k] = v;
  }

  // Map DO *binding* names → classes via wrangler's durable_objects config.
  /** @type {Record<string, new (s: any, e: any) => any>} */
  const doClasses = {};
  const doBindings = wrangler?.durable_objects?.bindings ?? [];
  for (const b of doBindings) {
    const Klass = exportedClasses[b.class_name];
    if (Klass) doClasses[b.name] = Klass;
  }

  // 2. Build env (late-bind the queue consumer = the worker's own handler).
  const { env } = createCloudEnv({
    targetConfig,
    root,
    target: config.target,
    vars: wrangler.vars ?? {},
    getQueueConsumer: () =>
      typeof handler.queue === 'function' ? handler.queue.bind(handler) : undefined,
    doClasses,
  });
  await settleEnv(env);

  // 3. Serve fetch over HTTP.
  const port = targetConfig.port ?? wrangler?.dev?.port ?? 8787;
  const { serve } = await import('@hono/node-server');
  const ctx = makeExecutionContext();

  const server = serve({
    port,
    fetch: (/** @type {Request} */ request) => handler.fetch(request, env, ctx),
  });

  // Cron: tick scheduled() on the worker's cadence (default every minute).
  let cronTimer = null;
  const crons = wrangler?.triggers?.crons;
  if (Array.isArray(crons) && crons.length > 0 && typeof handler.scheduled === 'function') {
    cronTimer = setInterval(() => {
      Promise.resolve(
        handler.scheduled({ cron: crons[0], scheduledTime: Date.now() }, env, ctx),
      ).catch((err) => console.error('[mieweb] scheduled() threw', err));
    }, 60_000);
  }

  console.log(`[mieweb] local host listening on http://localhost:${port} (target=${config.target})`);

  return {
    port,
    stop() {
      if (cronTimer) clearInterval(cronTimer);
      server?.close?.();
    },
  };
}

/** Minimal ExecutionContext: runs waitUntil work but doesn't block responses. */
function makeExecutionContext() {
  return {
    /** @param {Promise<unknown>} p */
    waitUntil(p) {
      Promise.resolve(p).catch((err) => console.error('[mieweb] waitUntil rejected', err));
    },
    passThroughOnException() {},
  };
}
