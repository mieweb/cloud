# `@mieweb/cloud`

A thin, stable **portability layer** over the platform primitives an app uses —
database, object storage, key/value, queues, stateful objects, vector index, and
AI. It is **inspired by Cloudflare's clean serverless APIs** and aims for
feature parity across runtimes — without promising a 1:1 match everywhere. The
organizing principle:

> **Cloudflare is the reference implementation and stays first-class and
> zero-overhead.** The layer never gets in the way of targeting Cloudflare: on
> that target your code runs against the native bindings, unchanged. The same
> application code can then target other runtimes — local Node today;
> `os.mieweb.org`, AWS, GCP later — through adapters that implement the same
> Cloudflare-shaped contract as faithfully as each environment allows.
>
> Design bias: **compatibility over purity, parity over perfection.** Adapters
> chase Cloudflare's behavior closely, but where a runtime genuinely can't match
> a primitive the difference is surfaced honestly (an explicit
> `UnsupportedBindingError` or a documented gap) rather than faked. The first
> version makes an existing Cloudflare codebase portable with the fewest
> possible source changes.

## Packages

| Package | Role |
| ------- | ---- |
| [`@mieweb/cloud-types`](packages/cloud-types) | The portable contracts (`CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, `CloudStatefulNamespace`, `CloudVectorIndex`, `CloudAI`) plus `UnsupportedBindingError`. On Cloudflare these are exact aliases of the native binding types. |
| [`@mieweb/cloud-workers`](packages/cloud-workers) | The `DurableObject` base. Backs the **`mieweb:workers`** virtual import: re-exports `cloudflare:workers` on Cloudflare (workerd export condition), pure-JS base everywhere else. |
| [`@mieweb/cloud`](packages/cloud) | Umbrella entry — re-exports the contracts + `DurableObject` from one stable import surface. |
| [`@mieweb/cloud-local`](packages/cloud-local) | Local/Node **adapters**: D1→SQLite, R2→filesystem, KV→in-memory, Queues→in-process, Durable Objects→in-process registry. Vectorize/Workers AI surface explicit `UnsupportedBindingError`. Includes a Node host harness + migration runner. |
| [`@mieweb/cloud-os`](packages/cloud-os) | The **`mieweb`** (os.mieweb.org / self-hosted) **adapters**: D1→libSQL, Vectorize→libSQL native vectors, R2→S3/MinIO, KV+Queues→Valkey. Durable Objects stay single-node. Ships a `docker-compose.yml` for the backing services. |
| [`@mieweb/cli`](packages/cli) | The **`mieweb`** CLI. On the `cloudflare` target it delegates verbatim to `wrangler`; on the `local`/`mieweb` targets it runs the matching adapter via the Node host harness. |
| [`@mieweb/test-app`](packages/test-app) | A tiny worker that exercises **every** contract surface over plain HTTP, plus a cross-target runner. The same worker + the same assertions prove the layer on `cloudflare`, `local`, and `mieweb`. See [Try it](#try-it-the-test-app). |

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

## Using the `mieweb` CLI

What the CLI *is* depends on where you point it. **If you're targeting
Cloudflare (or already know `wrangler`), think of it as a thin pass-through:**
every command is forwarded verbatim to `wrangler`, so there's nothing new to
learn and zero overhead. **On the other targets it is not a wrapper** — there is
no `wrangler` underneath; the CLI runs your unchanged worker on a Node host
harness backed by the adapters, reusing your `wrangler.jsonc` purely as
configuration. The active target comes from `--target <t>`, `MIEWEB_TARGET`, or
the `target` field in `mieweb.jsonc` (default `cloudflare`).

```sh
# cloudflare (default): every command is forwarded verbatim to wrangler
mieweb dev
mieweb deploy
mieweb d1 migrations apply <db>

# local: run the unchanged worker on the Node host harness (SQLite/fs/memory/in-proc)
mieweb --target local d1 migrations apply <db>
mieweb --target local dev

# mieweb (os.mieweb.org): run it on libSQL + S3/MinIO + Valkey
mieweb --target mieweb dev
```

On `cloudflare`, behavior is identical to `wrangler` (zero overhead). On the
`local`/`mieweb` targets the CLI imports the worker your `wrangler.jsonc` `main`
points at, builds an `Env` from the `mieweb.jsonc` driver hints, and serves
`fetch`/`queue`/`scheduled` over HTTP — the same handler Cloudflare runs.

## Try it: the test app

[`packages/test-app`](packages/test-app) is a worker whose routes each touch
exactly one binding — D1, R2, KV, Queues, Durable Objects, Vectorize, AI — so a
single set of HTTP assertions reads like a contract checklist. The cross-target
runner boots that worker on each target and runs the **same** checks:

```sh
pnpm install

# one target at a time
pnpm --filter @mieweb/test-app check:local    # in-process Node adapters
pnpm --filter @mieweb/test-app check:docker   # mieweb/os: spins up libSQL+MinIO+Valkey
pnpm --filter @mieweb/test-app check:cf        # Cloudflare via `wrangler dev` (Miniflare)

# everything available (docker auto-skips without Docker, cf without wrangler)
pnpm --filter @mieweb/test-app check:all
```

Surfaces a target can't provide answer `501 { skipped: true }` instead of
failing (e.g. Workers AI needs a model backend; Cloudflare local dev can't reach
Vectorize/AI without credentials), so one suite stays green everywhere. The
`local` target also runs as a plain `node --test` under `pnpm -r test`.

## Status

Proof-of-concept. Consumed today as a git submodule; npm / Deno / Bun
distribution is planned. Cloudflare is fully supported; the `local` Node target
and the `mieweb` (os.mieweb.org) target both cover D1, R2, KV, Queues, Durable
Objects, and Vectorize, with Workers AI available when a model backend is
configured. Every target is exercised by the [test app](#try-it-the-test-app)
and in [CI](.github/workflows/ci.yml).

## License

[MIT](LICENSE)
