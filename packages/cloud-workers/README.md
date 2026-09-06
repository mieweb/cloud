# `@mieweb/cloud-workers`

The `DurableObject` base class behind the **`mieweb:workers`** virtual import.

- On Cloudflare (workerd export condition) it re-exports `cloudflare:workers`.
- Everywhere else it is a pure-JS base with the same constructor shape, used by
  the in-process Durable Object adapter in `@mieweb/cloud-local`.

```js
import { DurableObject } from 'mieweb:workers';

export class Counter extends DurableObject { /* unchanged Cloudflare code */ }
```

The `mieweb:workers` specifier resolves via three coordinated aliases:
`tsconfig.json` `paths`, `wrangler.jsonc` `alias`, and this package's `exports`
conditions. See the
[repository README](https://github.com/mieweb/cloud#how-a-consuming-app-wires-it-in).

**Status: 0.x — the API may change between minor versions.**
