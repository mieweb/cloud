# `@mieweb/cloud`

Umbrella entry for the mieweb cloud portability layer: re-exports the portable
contracts from `@mieweb/cloud-types` and the `DurableObject` base from
`@mieweb/cloud-workers` behind one stable import.

```ts
import type { CloudDatabase, CloudBucket, CloudKV } from '@mieweb/cloud';
import { DurableObject } from '@mieweb/cloud';
```

On Cloudflare these are exact aliases of the native binding types — zero
overhead. On other targets the same code runs against adapters
(`@mieweb/cloud-local`, `@mieweb/cloud-os`).

**Status: 0.x — the API may change between minor versions.**

Full documentation, architecture, and the cross-target test app live in the
[repository README](https://github.com/mieweb/cloud#readme).
