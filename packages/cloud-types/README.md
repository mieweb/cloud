# `@mieweb/cloud-types`

The portable contracts of the mieweb cloud portability layer: `CloudDatabase`,
`CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`,
`CloudVectorIndex`, `CloudAI`, `CloudContainerNamespace`, plus
`UnsupportedBindingError`.

On Cloudflare each type is an exact alias of the native binding type (D1, R2,
KV, Queues, Durable Objects, Vectorize, Workers AI, Containers). Adapters for
other runtimes implement the same shape.

```ts
import type { CloudDatabase } from '@mieweb/cloud-types';

export default {
  async fetch(req: Request, env: { DB: CloudDatabase }) { /* … */ },
};
```

**Status: 0.x — the API may change between minor versions.**

Full documentation lives in the
[repository README](https://github.com/mieweb/cloud#readme).
