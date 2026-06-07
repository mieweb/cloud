/**
 * Type entry for `@mieweb/cloud-workers`.
 *
 * The canonical types are Cloudflare's. We re-export them so that, regardless
 * of which runtime implementation (`cloudflare.ts` / `node.ts`) is selected,
 * the *types* always match the Cloudflare contract the application is written
 * against. `DurableObject` / `WorkerEntrypoint` resolve to the ambient
 * definitions provided by `@cloudflare/workers-types`.
 */
export { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
