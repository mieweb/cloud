/**
 * `@mieweb/cloud` — the portability layer's single import surface.
 *
 * Most application code does not need to import from here yet: on Cloudflare
 * the existing `Env` interface and `cloudflare:workers` / `mieweb:workers`
 * imports continue to work unchanged. This module exists so that, as code is
 * gradually made portable, there is one stable place to import from:
 *
 *   import type { CloudBucket, CloudQueue } from '@mieweb/cloud';
 *   import { UnsupportedBindingError } from '@mieweb/cloud';
 *
 * The `DurableObject` base lives at `@mieweb/cloud/workers` (aliased as
 * `mieweb:workers`) so it can be resolved by the worker bundler's runtime
 * conditions; it is re-exported here for convenience.
 */
export * from './types.ts';
// Self-reference so bundlers pick the `workerd` export condition, not a file.
export { DurableObject, WorkerEntrypoint } from '@mieweb/cloud/workers';
