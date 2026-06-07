# `packages/` — the `@mieweb/*` portability layer

This folder holds the **`@mieweb/cloud` portability layer**: a thin, stable
contract over the platform primitives the app uses (database, object storage,
key/value, queues, stateful objects, vector index, AI). The single organizing
principle: **Cloudflare is the reference implementation and stays first-class
and zero-overhead**, while the same application code can target other runtimes
(local Node today; `os.mieweb.org`, AWS, GCP later) through adapters that
implement the same Cloudflare-shaped contract.

> Design bias: **compatibility over purity.** The first version makes the
> existing codebase portable with the fewest possible source changes — it is
> fine for the contract to look Cloudflare-shaped internally.

## What's here

| Package | Role |
| ------- | ---- |
| [`cloud-types`](cloud-types) | The portable contracts (`CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`, `CloudVectorIndex`, `CloudAI`) plus `UnsupportedBindingError`. On Cloudflare these are exact aliases of the native binding types, so `worker/env.ts` keeps compiling unchanged. |
| [`cloud-workers`](cloud-workers) | The `DurableObject` base. Backs the **`mieweb:workers`** virtual import: re-exports `cloudflare:workers` on Cloudflare (workerd export condition), pure-JS base everywhere else. |
| [`cloud`](cloud) | Umbrella entry. Re-exports the contracts + `DurableObject` from one stable import surface (`@mieweb/cloud`). |
| [`cloud-local`](cloud-local) | Local/Node **adapters** (the POC): D1→SQLite, R2→filesystem, KV→in-memory, Queues→in-process, Durable Objects→in-process registry. Vectorize/Workers AI surface explicit `UnsupportedBindingError`. Includes the Node **host harness** that runs the unchanged worker handler and a migration runner. |
| [`cli`](cli) | The **`mieweb`** CLI. On the `cloudflare` target it delegates verbatim to `wrangler`; on other targets it drives the matching adapter. |

## How it wires into the app

- `import { DurableObject } from 'mieweb:workers'` resolves via three coordinated
  aliases — `tsconfig.json` `paths` (typecheck), `wrangler.jsonc` `alias`
  (Cloudflare build), and the `@mieweb/cloud-workers` package `exports`
  conditions (runtime).
- `wrangler.jsonc` stays the source of truth for bindings/migrations/queues/DO
  tags. `mieweb.jsonc` is a small sidecar that adds only a `target` + non-CF
  adapter hints.
- The `mieweb` CLI reads both and either shells out to `wrangler` (Cloudflare)
  or runs the local adapters.

See the [root README](../README.md) for the full rationale and how a consuming
app wires this in.
