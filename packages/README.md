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
| [`cloud`](cloud) | **Zero dependencies.** The portable contracts (`CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`, `CloudVectorIndex`, `CloudAI`, `CloudContainerNamespace`, `UnsupportedBindingError`) and, at `@mieweb/cloud/workers`, the `DurableObject` base behind the **`mieweb:workers`** import (re-exports `cloudflare:workers` on workerd, pure-JS base elsewhere). The only package a Cloudflare app touches. |
| [`cloud-adapters`](cloud-adapters) | Off-Cloudflare **adapters** + the Node **host harness** and migration runner. `./local`: D1→SQLite, R2→filesystem, KV→in-memory, Queues→in-process, Durable Objects→in-process. `./os`: libSQL, S3/MinIO, Valkey. Backend SDKs are optional peers. |
| [`cli`](cli) | The **`mieweb`** CLI. On the `cloudflare` target it delegates verbatim to `wrangler`; on other targets it drives the matching adapter. |
| [`test-app`](test-app) *(private)* | Exercises every contract surface across all targets. |

## How it wires into the app

- `import { DurableObject } from 'mieweb:workers'` resolves via three coordinated
  aliases — `tsconfig.json` `paths` (typecheck), `wrangler.jsonc` `alias`
  (Cloudflare build), and the `@mieweb/cloud/workers` `exports`
  conditions (runtime).
- `wrangler.jsonc` stays the source of truth for bindings/migrations/queues/DO
  tags. `mieweb.jsonc` is a small sidecar that adds only a `target` + non-CF
  adapter hints.
- The `mieweb` CLI reads both and either shells out to `wrangler` (Cloudflare)
  or runs the local adapters.

See the [root README](../README.md) for the full rationale and how a consuming
app wires this in.
