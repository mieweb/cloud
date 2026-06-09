/**
 * Pure-JS fallback for `@mieweb/cloud-workers` used off Cloudflare (the
 * `default`/`node` export condition). This is the runtime entry that plain
 * `node` loads — the sibling `node.ts` carries the same shape with type
 * annotations for source consumers, and `index.d.ts` provides the public types.
 *
 * It mirrors the shape of the `cloudflare:workers` base classes closely enough
 * for application code: the constructor stores `ctx` + `env` on the instance
 * exactly like Cloudflare's `DurableObject<Env>`. The host harness in
 * `@mieweb/cloud-local` constructs instances and supplies a `ctx` that
 * implements the `DurableObjectState` surface the app actually uses (storage,
 * blockConcurrencyWhile, acceptWebSocket, ...).
 *
 * This intentionally does NOT emulate Cloudflare's placement, isolation, or
 * single-threaded concurrency guarantees — those are the host adapter's job.
 */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Minimal stand-in for Cloudflare's `WorkerEntrypoint`. Kept in parity with
 * `cloudflare.ts`.
 */
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
