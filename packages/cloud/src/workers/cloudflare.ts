/**
 * Cloudflare reference binding for `@mieweb/cloud-workers`.
 *
 * On the `workerd` runtime (Cloudflare Workers, selected via the `workerd`
 * export condition) this simply re-exports the native built-ins, so there is
 * zero behavioral or performance difference versus importing
 * `cloudflare:workers` directly. `mieweb:workers` aliases to this package, so
 * `import { DurableObject } from 'mieweb:workers'` is identical to the native
 * import when deployed to Cloudflare.
 */
export { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
