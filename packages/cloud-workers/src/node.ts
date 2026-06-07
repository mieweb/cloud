/**
 * Pure-JS fallback for `@mieweb/cloud-workers` used off Cloudflare (the
 * `default`/`node` export condition).
 *
 * It mirrors the shape of the `cloudflare:workers` base classes closely
 * enough for application code: the constructor stores `ctx` + `env` on the
 * instance exactly like Cloudflare's `DurableObject<Env>`. The host harness
 * in `@mieweb/cloud-local` is responsible for constructing instances and
 * supplying a `ctx` that implements the `DurableObjectState` surface the app
 * actually uses (storage, blockConcurrencyWhile, acceptWebSocket, ...).
 *
 * This intentionally does NOT emulate Cloudflare's placement, isolation, or
 * single-threaded concurrency guarantees — those are the host adapter's job.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Minimal stand-in for Cloudflare's `WorkerEntrypoint`. Not used by the app
 * today, but exported to keep the surface in parity with `cloudflare.ts`.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
