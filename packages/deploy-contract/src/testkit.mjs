/**
 * Provider conformance test-kit.
 *
 * Any `DeployProvider` implementation should pass this suite; the
 * Cloudflare/wrangler reference provider passes it first, and every other
 * provider (opensource-server, future AWS/GCP) must pass the *same* checks.
 * This is the control-plane analogue of the `@mieweb/test-app` cross-target
 * equivalence suite on the data plane.
 *
 * It is transport- and runner-agnostic: it exposes a single async
 * {@link runProviderConformance} that returns structured results, so it can be
 * driven from `node:test`, vitest, or a bare script. It asserts *contract*
 * behavior, not any provider's internals.
 *
 * Authored as plain ESM with JSDoc types (types published via `testkit.d.ts`)
 * so it loads under bare `node` — the wrangler provider's `node --test` suite
 * imports it directly.
 *
 * @typedef {import('./index.ts').DeployContext} DeployContext
 * @typedef {import('./index.ts').DeployProvider} DeployProvider
 * @typedef {import('./index.ts').DeployResult} DeployResult
 * @typedef {import('./index.ts').DeployTarget} DeployTarget
 * @typedef {import('./index.ts').ResourceHandle} ResourceHandle
 * @typedef {import('./testkit.d.ts').ConformanceCheck} ConformanceCheck
 * @typedef {import('./testkit.d.ts').ConformanceReport} ConformanceReport
 * @typedef {import('./testkit.d.ts').ConformanceOptions} ConformanceOptions
 */

import { RESOURCE_KINDS } from './runtime.mjs';

/**
 * Build a self-contained {@link DeployContext} plus captured log output.
 * @param {ConformanceOptions} opts
 * @returns {{ context: DeployContext, logs: string[], abort: AbortController }}
 */
function makeContext(opts) {
  /** @type {string[]} */
  const logs = [];
  const abort = new AbortController();
  /** @type {DeployContext} */
  const context = {
    root: opts.root ?? process.cwd(),
    target: opts.target,
    manifest: opts.manifest,
    mieweb: opts.mieweb ?? {},
    targetConfig: opts.targetConfig ?? {},
    argv: [],
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    signal: abort.signal,
  };
  return { context, logs, abort };
}

/**
 * The closed set of neutral resource kinds a {@link ResourceHandle} may declare,
 * imported from the contract's single source of truth (no local duplication).
 * @type {ReadonlySet<string>}
 */
const RESOURCE_KIND_SET = new Set(RESOURCE_KINDS);

/**
 * Shape-check a {@link DeployResult} without assuming a runner's assert lib.
 * @param {unknown} result
 * @returns {string|null} an error message, or null when valid
 */
function validateResult(result) {
  if (typeof result !== 'object' || result === null) {
    return 'deploy() must resolve to a DeployResult object';
  }
  const r = /** @type {Partial<DeployResult>} */ (result);
  if (!Array.isArray(r.resources)) {
    return 'DeployResult.resources must be an array';
  }
  for (const [i, res] of /** @type {ResourceHandle[]} */ (r.resources).entries()) {
    if (typeof res?.binding !== 'string' || res.binding.length === 0) {
      return `resources[${i}].binding must be a non-empty string`;
    }
    if (typeof res?.kind !== 'string' || !RESOURCE_KIND_SET.has(res.kind)) {
      return `resources[${i}].kind must be one of the declared ResourceKind values, got ${JSON.stringify(res?.kind)}`;
    }
    if (typeof res?.id !== 'string') {
      return `resources[${i}].id must be a string (opaque provider identity)`;
    }
  }
  if (r.url !== undefined && typeof r.url !== 'string') {
    return 'DeployResult.url, when present, must be a string';
  }
  return null;
}

/**
 * Run the conformance suite against a provider.
 *
 * Structural checks (always run):
 *   1. `name` is a non-empty string.
 *   2. `supports(target)` returns true for the configured target.
 *   3. `deploy` is a function.
 *
 * Behavioral checks (only when `live: true`, since they invoke the backend):
 *   4. `deploy` resolves to a well-formed {@link DeployResult}.
 *   5. Handle stability: a second run with the ids from the first surfaces the
 *      same {binding, kind, id} handles (not full backend idempotency — the kit
 *      cannot observe backend reuse; see the inline note).
 *
 * @param {DeployProvider} provider
 * @param {ConformanceOptions} opts
 * @returns {Promise<ConformanceReport>}
 */
export async function runProviderConformance(provider, opts) {
  /** @type {ConformanceCheck[]} */
  const checks = [];
  /** @param {string} name @param {boolean} ok @param {string} [detail] */
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  record('provider.name is a non-empty string', typeof provider.name === 'string' && provider.name.length > 0);
  record(
    `provider.supports("${opts.target}") is true`,
    typeof provider.supports === 'function' && provider.supports(opts.target) === true,
  );
  record('provider.deploy is a function', typeof provider.deploy === 'function');

  if (opts.live) {
    try {
      const { context } = makeContext(opts);
      const first = await provider.deploy(context);
      const err = validateResult(first);
      record('deploy() resolves to a valid DeployResult', err === null, err ?? undefined);

      // Idempotency: feed the first run's ids back into the manifest and redeploy.
      // How ids map back into a manifest is provider-specific, so the caller
      // supplies `applyIds`. Without it we skip the round-trip rather than assume
      // a wrangler-shaped manifest (which would produce false failures for other
      // providers).
      if (typeof opts.applyIds === 'function') {
        const merged = opts.applyIds(opts.manifest, first.resources ?? []);
        const { context: second } = makeContext({ ...opts, manifest: merged });
        const again = await provider.deploy(second);
        const againErr = validateResult(again);
        record('second deploy() also resolves to a valid DeployResult', againErr === null, againErr ?? undefined);
        // NOTE: this verifies *handle stability* — that a redeploy with the
        // first run's ids returns the same {binding, kind, id} handles — not
        // true backend idempotency. The kit cannot observe whether the backend
        // reused vs. destroyed+recreated a resource; a provider that recreates
        // while returning the same handle passes. Stronger idempotency proof
        // needs provider-observable reuse evidence, out of scope for the kit.
        const stable =
          againErr === null &&
          JSON.stringify(idset(first.resources ?? [])) === JSON.stringify(idset(again.resources ?? []));
        record(
          'deploy() handles are stable across reruns (ids/kinds unchanged)',
          stable,
          stable ? undefined : 'second deploy returned a different/invalid set of resource handles',
        );
      } else {
        // Handle-stability is a core obligation. Without an `applyIds` hook it
        // cannot run — record an explicit *failed* check so a passing report can
        // never be mistaken for full conformance. Provide `applyIds` (or run
        // without `live`) to satisfy this.
        record(
          'deploy() handle stability checked',
          false,
          'live conformance requires an `applyIds` hook to verify handle stability; none was provided',
        );
      }
    } catch (e) {
      record('deploy() completed without throwing', false, e instanceof Error ? e.message : String(e));
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return { provider: provider.name, checks, failures };
}

/**
 * Sorted `binding→kind:id` view, for order-independent comparison. Includes
 * `kind` because a kind change on the second deploy (same binding/id) is not an
 * idempotent result — it violates the `ResourceHandle` contract.
 * @param {readonly ResourceHandle[]} resources
 * @returns {Array<[string, string]>}
 */
function idset(resources) {
  return resources
    .map((r) => /** @type {[string, string]} */ ([r.binding, `${r.kind}:${r.id}`]))
    .sort((a, b) => a[0].localeCompare(b[0]));
}
