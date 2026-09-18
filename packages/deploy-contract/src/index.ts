/**
 * `@mieweb/deploy-contract` — the provider-agnostic deploy contract.
 *
 * ## What this is
 *
 * `@mieweb/cli` needs to run deploy verbs (`deploy`, `dev`, `tail`, …) without
 * knowing *how* any particular backend does the work. This module defines the
 * single interface — {@link DeployProvider} — that the CLI consumes and every
 * backend implements. Cloudflare is the **reference provider**
 * (`@mieweb/deploy-wrangler`, which wraps the real `wrangler` binary);
 * os.mieweb.org / opensource-server is another; AWS/GCP could be more.
 *
 * ## Design bias: the contract owns *what*, providers own *how*
 *
 * Deliberately absent from this file:
 *   - wrangler.jsonc field names (`database_id`, `bucket_name`, …),
 *   - any backend request/response shape (the opensource-server Manager API),
 *   - the `mieweb+<driver>:` resource-URI grammar.
 *
 * Those are all provider implementation details. The contract speaks only in
 * neutral terms: a {@link DeployContext} in, a {@link DeployResult} out, with
 * resource identity carried as an **opaque** {@link ResourceHandle.id} that the
 * CLI reports and is expected to persist back into the config verbatim
 * (short-circuiting the next provision) without ever interpreting it. Note:
 * automatic write-back is not yet implemented — today the CLI reports the ids
 * for the user to commit; see {@link ResourceHandle} for the current guarantee.
 *
 * This mirrors the data-plane half of the portability layer: just as
 * `@mieweb/cloud` defines Cloudflare-shaped binding *contracts* that
 * `@mieweb/cloud-adapters` implement, this package defines a control-plane
 * *contract* that deploy providers implement.
 */

/**
 * Which platform a deploy targets. Open-ended on purpose: the contract does not
 * enumerate a closed set, so new providers can introduce their own target names
 * and advertise them via {@link DeployProvider.supports}. The well-known values
 * mirror `CloudTarget` in `@mieweb/cloud`.
 */
export type DeployTarget = 'cloudflare' | 'local' | 'mieweb' | 'aws' | 'gcp' | (string & {});

/**
 * Structured logging sink the CLI supplies. Providers MUST route their own
 * human-facing messages through this rather than `console.*`, so the CLI stays
 * in control of formatting, verbosity, and stream routing (and tests can
 * capture output).
 *
 * **Subprocess exception.** A provider that delegates to an interactive child
 * process (e.g. the reference provider shelling out to `wrangler`) MAY let that
 * child inherit the terminal's stdio directly, because a long-running,
 * TTY-aware tool needs live colors, progress, and interactive prompts that a
 * line-buffered logger would break. Such passthrough output is the child's, not
 * the provider's, and is expected to reach the terminal unmediated. Everything
 * the *provider itself* emits still goes through this logger.
 */
export interface DeployLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The resolved project context the CLI hands a provider for every verb. This is
 * a neutral projection of the CLI's internal config (`MiewebConfig`) — a
 * provider receives exactly what it needs to act, and nothing about the CLI's
 * own plumbing.
 */
export interface DeployContext {
  /** Absolute repository root — the directory holding the resolved config. */
  readonly root: string;

  /** The resolved active target for this invocation. */
  readonly target: DeployTarget;

  /**
   * The parsed declarative resource manifest (wrangler.jsonc). Passed as an
   * opaque object: a provider reads whatever fields it understands. The
   * reference provider hands it straight to wrangler; other providers read the
   * bindings/resources they support and ignore the rest.
   */
  readonly manifest: Readonly<Record<string, unknown>>;

  /**
   * Absolute path to the manifest file on disk (the resolved `wrangler.jsonc`,
   * honoring any custom location). Providers that shell out to a tool needing an
   * explicit `--config`, or that must re-read the file after a deploy to pick up
   * written-back resource ids, should use this rather than assuming a fixed
   * filename under {@link root}. Undefined when the manifest was synthesized
   * rather than loaded from a file.
   */
  readonly manifestPath?: string;

  /**
   * The parsed mieweb sidecar config (mieweb.jsonc), or `{}` when absent.
   * Holds mieweb-specific, non-wrangler configuration (target selection,
   * per-target adapter settings).
   */
  readonly mieweb: Readonly<Record<string, unknown>>;

  /**
   * Provider/adapter configuration scoped to the active target
   * (`mieweb.jsonc` → `targets[target]`), or `{}` when absent. This is
   * **non-secret** configuration — a provider package name, a backend location
   * (e.g. a self-hosted instance URL), tuning knobs — because it comes from an
   * on-disk, potentially committed file.
   *
   * **Secrets do not belong here.** Credentials/tokens a provider needs are read
   * from the environment via {@link DeployProviderFactory} (`createProvider(env)`),
   * never from `targetConfig` and never from {@link manifest}. This keeps the
   * "credentials never travel through the contract in a serializable form"
   * guarantee (see {@link AuthStatus}) intact and gives provider authors one
   * clear secret-handling boundary.
   */
  readonly targetConfig: Readonly<Record<string, unknown>>;

  /** Passthrough arguments that followed the verb (e.g. `--dry-run`, `--env prod`). */
  readonly argv: readonly string[];

  /** Structured output sink. Providers must not write to stdout/stderr directly. */
  readonly logger: DeployLogger;

  /**
   * Cooperative cancellation. Aborted when the user interrupts (Ctrl-C) or a
   * timeout fires; long-running providers should observe it and abort promptly.
   */
  readonly signal: AbortSignal;
}

/** Re-export of the canonical runtime kinds list (single source of truth). */
export { RESOURCE_KINDS } from './runtime.mjs';

/**
 * The contract's neutral vocabulary for a provisionable resource, decoupled
 * from any provider's naming (D1/R2/KV → database/bucket/kv, etc.). Derived from
 * {@link RESOURCE_KINDS} so the type and the runtime allowlist can never drift.
 */
export type ResourceKind = (typeof import('./runtime.mjs').RESOURCE_KINDS)[number];

/**
 * A resource the provider ensured exists during a deploy. The CLI reports these
 * to the user; {@link id} is intended to be persisted back into the committed
 * config so the next deploy short-circuits provisioning for that binding.
 *
 * **Current guarantee: reported-only.** Automatic write-back into the manifest
 * is a planned follow-up; today the CLI *reports* the ids and the user commits
 * them. Provider authors should populate ids so write-back can be enabled later,
 * but must not assume the CLI persists them yet.
 */
export interface ResourceHandle {
  /** The binding name as it appears in the manifest (`DB`, `RECORDINGS`, …). */
  readonly binding: string;

  /** The contract's neutral kind for this resource. */
  readonly kind: ResourceKind;

  /**
   * Opaque, provider-owned identity for the resource. The CLI treats this as a
   * black box: it never parses it, and is expected to write it back into the
   * config unchanged once write-back lands (reported-only today). The reference
   * provider stores a Cloudflare resource id here; other providers may store any
   * string (e.g. a URI) — that is their private affair.
   */
  readonly id: string;
}

/** Outcome of a {@link DeployProvider.deploy} run. Neutral: no provider-specific fields. */
export interface DeployResult {
  /** Public URL the deployed worker is reachable at, when the provider knows it. */
  readonly url?: string;

  /**
   * Resources ensured or created during this deploy. Empty is valid (e.g. a
   * code-only redeploy). The CLI uses these to report status and (once
   * write-back lands) to persist
   * ids back into the config.
   */
  readonly resources: readonly ResourceHandle[];
}

/**
 * A long-running handle returned by {@link DeployProvider.dev}. The CLI keeps
 * the process alive and calls {@link stop} on interrupt.
 */
export interface DeployHandle {
  /** Local URL the dev server is listening on, when known. */
  readonly url?: string;

  /**
   * Resolves when the underlying process ends on its own, and rejects if it
   * ends abnormally (non-zero exit / killed by a signal). The CLI races this
   * against its interrupt signal so a crashed `dev` returns instead of hanging.
   * Optional: providers whose `dev` cannot exit on its own may omit it.
   */
  readonly closed?: Promise<void>;

  /** Tear down the running dev process. Idempotent. */
  stop(): void | Promise<void>;
}

/**
 * The result of an authentication-status check ({@link DeployProvider.whoami}).
 *
 * Credentials themselves NEVER travel through the contract in a form that could
 * be logged or serialized — a provider reads them from the environment at
 * construction time (see {@link DeployProviderFactory}). This type only reports
 * *whether* the provider is authenticated and, optionally, a non-secret label
 * (account id, username, email) suitable for display.
 */
export interface AuthStatus {
  /** Whether the provider currently has usable credentials for its backend. */
  readonly authenticated: boolean;
  /** Non-secret identity label to show the user (`account`, `user@host`, …). */
  readonly account?: string;
  /** How the credentials were obtained, for diagnostics (`'env'`, `'oauth'`, …). */
  readonly method?: string;
}

/**
 * Thrown by a provider when a verb cannot proceed because the caller is not
 * authenticated (or the credentials are expired/insufficient). The
 * control-plane analogue of `UnsupportedBindingError` on the data plane.
 *
 * The runtime implementation lives in `runtime.mjs` (plain ESM) so that
 * bare-`node` `.mjs` providers can `throw new AuthError(...)` and the CLI can
 * `instanceof`-check it without a TypeScript loader; it is re-exported here so
 * TypeScript consumers see a single contract surface.
 */
export { AuthError } from './runtime.mjs';

/**
 * The interface `@mieweb/cli` imports and drives. A provider is any object
 * satisfying this shape; the CLI selects one whose {@link supports} returns
 * true for the active target, then calls the requested verb.
 *
 * Only {@link deploy} is required. Optional verbs let the CLI degrade with a
 * clear "not supported by provider X" message instead of silently misbehaving —
 * the control-plane analogue of `UnsupportedBindingError` on the data plane.
 *
 * Contract obligations for implementers:
 *   - **Idempotency:** repeated {@link deploy} calls with the same context
 *     converge to the same state. Resources whose id is already present in the
 *     manifest MUST be reused, not recreated.
  *   - **No direct I/O to the console:** use {@link DeployContext.logger} for
  *     the provider's own messages. Delegated interactive child processes may
  *     inherit stdio (see {@link DeployLogger}).
  *   - **Honor cancellation:** observe {@link DeployContext.signal}.
  *   - **Opaque ids:** never require the CLI to understand {@link ResourceHandle.id}.
  *   - **Signal auth failures with {@link AuthError}:** throw it (not a bare
  *     `Error`) for backend 401/403, so the CLI can prompt the user to log in.
 */
export interface DeployProvider {
  /** Stable identifier for diagnostics (`'wrangler'`, `'opensource-server'`). */
  readonly name: string;

  /**
   * Whether this provider can service the given target. The CLI calls this to
   * pick a provider; the first that returns true wins.
   */
  supports(target: DeployTarget): boolean;

  /**
   * Ensure the manifest's resources exist and push the worker. Idempotent.
   * This is the core verb every provider must implement.
   */
  deploy(context: DeployContext): Promise<DeployResult>;

  /** Start a local/remote dev loop. Absent ⇒ CLI reports the verb unsupported. */
  dev?(context: DeployContext): Promise<DeployHandle>;

  /** Stream logs from the deployed worker. Absent ⇒ CLI reports unsupported. */
  tail?(context: DeployContext): Promise<void>;

  /** Tear down what {@link deploy} created. Absent ⇒ CLI reports unsupported. */
  destroy?(context: DeployContext): Promise<void>;

  /**
   * Report whether the provider is currently authenticated against its backend,
   * without performing any deploy work. The CLI may call this before a deploy to
   * fail fast with a helpful message, and it backs `mieweb whoami`.
   *
   * Absent ⇒ the CLI assumes the provider self-manages auth ambiently (e.g. via
   * environment credentials) and proceeds; verbs may still throw {@link AuthError}.
   */
  whoami?(context: DeployContext): Promise<AuthStatus>;

  /**
   * Establish credentials for the backend — typically an interactive flow
   * (browser OAuth, device code, token prompt). Backs `mieweb login`.
   *
   * Absent ⇒ the CLI reports that this provider takes credentials from the
   * environment and there is nothing to log into. Providers that authenticate
   * purely via env tokens should omit this rather than implement a no-op.
   */
  login?(context: DeployContext): Promise<void>;

  /**
   * Revoke or clear locally-cached credentials. Backs `mieweb logout`. Absent ⇒
   * CLI reports there is no stored session to clear.
   */
  logout?(context: DeployContext): Promise<void>;
}

/**
 * A provider module's expected shape. The CLI resolves a provider by importing
 * its package and reading either a `default` export that is a
 * {@link DeployProvider}, or a `createProvider` factory that returns one. The
 * factory form lets a provider read host-bootstrap configuration from the
 * environment (endpoints, credentials) at construction time.
 */
export interface DeployProviderModule {
  default?: DeployProvider;
  createProvider?: DeployProviderFactory;
}

/**
 * A dependency-free view of the process environment. Equivalent in shape to
 * `NodeJS.ProcessEnv`, but declared locally so this zero-dependency contract
 * does not require `@types/node` to resolve — a consumer that only installs the
 * contract can still type a provider factory.
 */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * Factory that builds a provider. Receives the process environment for
 * host-bootstrap config only (never the worker's `env`) — this is where a
 * provider reads its backend location + credentials (e.g. a self-hosted
 * instance URL and token), keeping them out of the committed manifest and the
 * {@link DeployContext}. Kept synchronous so provider selection stays cheap; do
 * real I/O inside the verbs.
 */
export type DeployProviderFactory = (env: ProviderEnv) => DeployProvider;
