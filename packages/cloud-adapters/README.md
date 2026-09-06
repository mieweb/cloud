# `@mieweb/cloud-adapters`

Off-Cloudflare implementations of the [`@mieweb/cloud`](../cloud) contracts,
plus the Node **host harness** that runs the unchanged worker handler. The
`mieweb` CLI drives this package for the `local` and `mieweb` targets; apps
rarely import it directly.

| Subpath | Target | Backends |
| --- | --- | --- |
| `.` / `./local` | `local` — zero external services | D1→SQLite (`better-sqlite3`, FTS5 kept), R2→filesystem, KV→in-memory, Queues→in-process, Durable Objects→in-process registry, Vectorize→`sqlite-vec`, AI→Ollama when configured |
| `./os` | `mieweb` — os.mieweb.org / self-hosted | D1→libSQL/sqld, Vectorize→libSQL native vectors, R2→S3-compatible (MinIO, SeaweedFS, AWS), KV+Queues→Valkey/Redis; AI + Durable Objects reused from local |
| `./host` | both | `startLocalHost({ config })` — imports the worker, builds `Env`, serves `fetch`/`queue`/`scheduled` |
| `./migrate` | both | `applyMigrations` for wrangler-style D1 migrations |

Importing `./os` registers its drivers into the shared registry
(`registerDriver(name, factory)`), so `createCloudEnv` dispatches by the
`driver` field in `mieweb.jsonc` with no core changes. Surfaces a target can't
provide throw an explicit `UnsupportedBindingError` rather than failing quietly.

## Backend SDKs are optional peers

Install only what your target uses; each adapter loads its SDK lazily and
throws a clear "install X" error if it's missing.

```sh
# local target
pnpm add -D better-sqlite3 sqlite-vec

# mieweb target
pnpm add -D @libsql/client @aws-sdk/client-s3 ioredis
```

## Configure the `mieweb` target

Copy the `targets.mieweb` block from [`mieweb.sample.jsonc`](./mieweb.sample.jsonc)
into the app's `mieweb.jsonc`, then `mieweb --target mieweb dev`.

## Develop / test against live infra

```sh
pnpm --filter @mieweb/cloud-adapters infra:up    # libSQL + MinIO + Valkey (docker compose)
pnpm --filter @mieweb/cloud-adapters test        # local + os conformance suites
pnpm --filter @mieweb/cloud-adapters infra:down  # tear down (-v removes volumes)
```

Both suites self-skip whatever isn't installed or reachable, so `pnpm -r test`
stays green without Docker or native builds.

**Status: 0.x — the API may change between minor versions.**

Full documentation lives in the
[repository README](https://github.com/mieweb/cloud#readme).
