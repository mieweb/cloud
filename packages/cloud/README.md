# `@mieweb/cloud`

The mieweb cloud portability layer's one dependency-free package: the portable
contracts and the `DurableObject` shim behind the `mieweb:workers` import.

```ts
import type { CloudDatabase, CloudBucket, CloudKV } from '@mieweb/cloud';
import { DurableObject } from 'mieweb:workers';   // → @mieweb/cloud/workers
```

| Export | Contents |
| --- | --- |
| `@mieweb/cloud` | `CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`, `CloudVectorIndex`, `CloudAI`, `CloudContainerNamespace`, `UnsupportedBindingError`; re-exports `DurableObject` |
| `@mieweb/cloud/workers` | `DurableObject`, `WorkerEntrypoint` — re-exports `cloudflare:workers` under the `workerd` export condition, pure-JS base everywhere else |

On Cloudflare every type is an exact alias of the native binding type and the
shim is the real `cloudflare:workers` — zero overhead, no code changes. Off
Cloudflare the same code runs against
[`@mieweb/cloud-adapters`](https://www.npmjs.com/package/@mieweb/cloud-adapters).

The `mieweb:workers` specifier resolves via `wrangler.jsonc` `alias` and
`tsconfig.json` `paths`, both pointing at `@mieweb/cloud/workers`; `mieweb init`
writes these for you.

**Status: 0.x — the API may change between minor versions.**

Full documentation lives in the
[repository README](https://github.com/mieweb/cloud#readme).
