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

import { isDeepStrictEqual } from 'node:util';
import { RESOURCE_KINDS } from './runtime.mjs';

/**
 * Build a self-contained {@link DeployContext} with a silent logger.
 * @param {ConformanceOptions} opts
 * @returns {DeployContext}
 */
function makeContext(opts) {
  const silent = () => {};
  return {
    root: opts.root ?? process.cwd(),
    target: opts.target,
    manifest: opts.manifest,
    targetConfig: opts.targetConfig ?? {},
    argv: [],
    logger: { info: silent, warn: silent, error: silent },
    signal: new AbortController().signal,
  };
}

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
 * Behavioral checks (only when `live: true` and the structural checks passed,
 * since they invoke the backend):
 *   4. `deploy` resolves to a well-formed {@link DeployResult}.
 *   5. Handle stability: deploying the same context again returns the same
 *      {binding, kind, id} handles. (The kit can't observe whether the backend
 *      reused or recreated a resource, only that the handles are stable.)
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

  // Only deploy for real once the provider has passed the structural checks
  // (e.g. it actually supports this target), so a misconfigured provider can't
  // cause side effects.
  if (opts.live && checks.every((c) => c.ok)) {
    try {
      const first = await provider.deploy(makeContext(opts));
      const err = validateResult(first);
      record('deploy() resolves to a valid DeployResult', err === null, err ?? undefined);
      const again = await provider.deploy(makeContext(opts));
      const againErr = validateResult(again);
      record('second deploy() also resolves to a valid DeployResult', againErr === null, againErr ?? undefined);
      const stable = againErr === null && isDeepStrictEqual(handles(first.resources), handles(again.resources));
      record(
        'deploy() handles are stable across reruns (ids/kinds unchanged)',
        stable,
        stable ? undefined : 'second deploy returned a different/invalid set of resource handles',
      );
    } catch (e) {
      record('deploy() completed without throwing', false, e instanceof Error ? e.message : String(e));
    }
  }

  const failures = checks.filter((c) => !c.ok);
  return { provider: provider.name, checks, failures };
}

/**
 * Order-independent `binding kind:id` view of a deploy's handles.
 * @param {readonly ResourceHandle[]} resources
 * @returns {string[]}
 */
function handles(resources) {
  return resources.map((r) => `${r.binding} ${r.kind}:${r.id}`).sort();
}
