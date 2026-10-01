import type { DeployProvider, DeployTarget, ResourceHandle } from './index.js';

/** A single conformance assertion outcome. */
export interface ConformanceCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Populated when `ok` is false. */
  readonly detail?: string;
}

/** Aggregate result of a conformance run. */
export interface ConformanceReport {
  readonly provider: string;
  readonly checks: readonly ConformanceCheck[];
  /** Convenience view: the subset of `checks` that failed. */
  readonly failures: readonly ConformanceCheck[];
}

/** Options describing the fixture project to exercise the provider against. */
export interface ConformanceOptions {
  /** Target to advertise + deploy for. Must be one the provider `supports`. */
  readonly target: DeployTarget;
  /** Fixture manifest (a wrangler.jsonc-shaped object). */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** Fixture mieweb.jsonc. Defaults to `{}`. */
  readonly mieweb?: Readonly<Record<string, unknown>>;
  /** Fixture per-target config. Defaults to `{}`. */
  readonly targetConfig?: Readonly<Record<string, unknown>>;
  /** Absolute root for the fixture. Defaults to `process.cwd()`. */
  readonly root?: string;
  /**
   * When true, actually invoke `deploy` (side effects!). Defaults to false so
   * the kit can validate the interface contract without provisioning anything.
   * Set true in an environment where the provider's backend is reachable.
   */
  readonly live?: boolean;
  /**
   * Provider-specific hook that merges the ids from a first deploy back into the
   * manifest, so the kit can verify **handle stability** on a second run (that
   * the same {binding, kind, id} handles come back — not full backend
   * idempotency, which the kit cannot observe). Because id placement is
   * provider-specific (there is no mandated manifest layout), the caller supplies
   * it. **Required for a fully-passing `live` run:** when omitted on a live run,
   * the kit records an explicit *failed* handle-stability check rather than
   * silently skipping the obligation.
   */
  readonly applyIds?: (
    manifest: Readonly<Record<string, unknown>>,
    resources: readonly ResourceHandle[],
  ) => Record<string, unknown>;
}

/** Run the conformance suite against a provider. */
export function runProviderConformance(
  provider: DeployProvider,
  opts: ConformanceOptions,
): Promise<ConformanceReport>;
