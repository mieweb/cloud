/**
 * `@mieweb/cloud` — the stable, portable contract for the platform
 * services this application depends on.
 *
 * Design bias: **compatibility over purity.** On Cloudflare (the reference
 * implementation) every `Cloud*` type below is an exact alias of the native
 * binding type, so the existing `Env` interface and all call sites keep
 * compiling and behaving identically with zero changes. Non-Cloudflare
 * adapters (`@mieweb/cloud-adapters`, future AWS/GCP) implement the
 * same Cloudflare-shaped contract.
 *
 * These aliases reference the ambient types from `@cloudflare/workers-types`
 * (pulled in globally via the root `tsconfig.json` `types` array), so they
 * resolve without an explicit dependency edge.
 *
 *  | Cloudflare primitive | Portable concept              | Alias               |
 *  | -------------------- | ----------------------------- | ------------------- |
 *  | D1                   | SQLite-compatible database    | `CloudDatabase`     |
 *  | R2                   | object storage (S3/fs-backed) | `CloudBucket`       |
 *  | KV                   | Redis-like key/value          | `CloudKV`           |
 *  | Queues               | portable job queue            | `CloudQueue<T>`     |
 *  | Durable Objects      | Artipods / stateful container | `CloudStatefulNamespace` |
 *  | Vectorize            | Footnote vector index         | `CloudVectorIndex`  |
 *  | Workers AI           | Ozwell AI gateway             | `CloudAI`           |
 *  | Containers           | DO-controlled Linux container | `CloudContainerNamespace` |
 */

/** SQLite-compatible database (Cloudflare D1). */
export type CloudDatabase = D1Database;
export type CloudPreparedStatement = D1PreparedStatement;
export type CloudDatabaseResult<T = Record<string, unknown>> = D1Result<T>;

/** S3-compatible / filesystem-backed object storage (Cloudflare R2). */
export type CloudBucket = R2Bucket;
export type CloudObject = R2Object;
export type CloudObjectBody = R2ObjectBody;

/** Redis-like key/value store (Cloudflare KV). */
export type CloudKV = KVNamespace;

/** Portable job queue producer (Cloudflare Queues). */
export type CloudQueue<Body = unknown> = Queue<Body>;
export type CloudMessageBatch<Body = unknown> = MessageBatch<Body>;
export type CloudMessage<Body = unknown> = Message<Body>;

/**
 * Namespace of stateful, addressable objects ("Artipods" / Durable Objects).
 * Obtain a stub with `ns.get(ns.idFromName(key))` and talk to it via `.fetch`.
 */
export type CloudStatefulNamespace = DurableObjectNamespace;
export type CloudStatefulState = DurableObjectState;
export type CloudStatefulStub = DurableObjectStub;
export type CloudStatefulId = DurableObjectId;

/** Vector similarity index ("Footnote" / Cloudflare Vectorize). */
export type CloudVectorIndex = VectorizeIndex;

/** AI model gateway ("Ozwell" / Cloudflare Workers AI). */
export type CloudAI = Ai;

/**
 * Namespace of Durable-Object-controlled Linux containers (Cloudflare
 * Containers). A container binding *is* a DO namespace: the app-side class
 * (`class MyContainer extends Container`, from `@cloudflare/containers`)
 * extends a Durable Object, and `wrangler.jsonc` pairs a `containers` array
 * entry with an ordinary `durable_objects.bindings` entry.
 *
 * Cloudflare-only for now: non-Cloudflare adapters surface
 * `UnsupportedBindingError` until a portable runtime emulates `ctx.container`
 * (see container-plan.md, Milestone 4).
 */
export type CloudContainerNamespace = DurableObjectNamespace;
/** What `getContainer(ns, id)` / `ns.get(id)` returns — a routable stub. */
export type CloudContainerStub = DurableObjectStub;

/** Per-request lifecycle hook (`waitUntil`, `passThroughOnException`). */
export type CloudExecutionContext = ExecutionContext;

/**
 * The shape a portable runtime adapter must produce: the top-level handler an
 * application exports. Mirrors Cloudflare's `ExportedHandler` so the app's
 * `export default { fetch, queue, scheduled }` satisfies it unchanged.
 */
export type CloudHandler<Env = unknown, QueueBody = unknown> = ExportedHandler<
  Env,
  QueueBody
>;

/**
 * Which platform a given environment targets. The reference adapter is
 * `'cloudflare'`; everything else degrades gracefully or throws
 * `UnsupportedBindingError` for primitives it can't emulate.
 */
export type CloudTarget =
  | 'cloudflare'
  | 'local'
  | 'mieweb'
  | 'aws'
  | 'gcp';

/**
 * Thrown when application code reaches for a binding the active adapter does
 * not implement (e.g. Vectorize/Workers AI outside Cloudflare). Adapters
 * should fail loudly and explicitly rather than silently returning bad data —
 * callers that can degrade (e.g. search → FTS-only) catch this and adapt.
 */
export class UnsupportedBindingError extends Error {
  readonly binding: string;
  readonly target: CloudTarget;

  constructor(binding: string, target: CloudTarget, hint?: string) {
    super(
      `Binding "${binding}" is not supported on target "${target}"${
        hint ? `: ${hint}` : '.'
      }`,
    );
    this.name = 'UnsupportedBindingError';
    this.binding = binding;
    this.target = target;
  }
}
