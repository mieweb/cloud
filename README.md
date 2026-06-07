# `@mieweb/cloud`

A thin, stable **portability layer** over the platform primitives an app uses —
database, object storage, key/value, queues, stateful objects, vector index, and
AI. The organizing principle:

> **Cloudflare is the reference implementation and stays first-class and
> zero-overhead.** The same application code can target other runtimes — local
> Node today; `os.mieweb.org`, AWS, GCP later — through adapters that implement
> the same Cloudflare-shaped contract.
>
> Design bias: **compatibility over purity.** The first version makes an existing
> Cloudflare codebase portable with the fewest possible source changes.

## Packages

| Package | Role |
| ------- | ---- |
| [`@mieweb/cloud-types`](packages/cloud-types) | The portable contracts (`CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`, `CloudVectorIndex`, `CloudAI`) plus `UnsupportedBindingError`. On Cloudflare these are exact aliases of the native binding types. |
| [`@mieweb/cloud-workers`](packages/cloud-workers) | The `DurableObject` base. Backs the **`mieweb:workers`** virtual import: re-exports `cloudflare:workers` on Cloudflare (workerd export condition), pure-JS base everywhere else. |
| [`@mieweb/cloud`](packages/cloud) | Umbrella entry — re-exports the contracts + `DurableObject` from one stable import surface. |
| [`@mieweb/cloud-local`](packages/cloud-local) | Local/Node **adapters**: D1→SQLite, R2→filesystem, KV→in-memory, Queues→in-process, Durable Objects→in-process registry. Vectorize/Workers AI surface explicit `UnsupportedBindingError`. Includes a Node host harness + migration runner. |
| [`@mieweb/cli`](packages/cli) | The **`mieweb`** CLI. On the `cloudflare` target it delegates verbatim to `wrangler`; on other targets it drives the matching adapter. |

## How a consuming app wires it in

- `import { DurableObject } from 'mieweb:workers'` resolves via three coordinated
  aliases — `tsconfig.json` `paths` (typecheck), `wrangler.jsonc` `alias`
  (Cloudflare build), and the `@mieweb/cloud-workers` package `exports`
  conditions (runtime).
- `wrangler.jsonc` stays the source of truth for bindings/migrations/queues/DO
  tags. A small `mieweb.jsonc` sidecar adds only a `target` + non-Cloudflare
  adapter hints.
- The `mieweb` CLI reads both and either shells out to `wrangler` (Cloudflare)
  or runs the local adapters.

## Status

Proof-of-concept. Consumed today as a git submodule; npm / Deno / Bun
distribution is planned. Cloudflare is fully supported; the local Node target
covers D1, R2, KV, Queues, and Durable Objects.

## License

[MIT](LICENSE)
