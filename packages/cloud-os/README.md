# @mieweb/cloud-os

Adapters for the **`mieweb`** target (`os.mieweb.org` / self-hosted), implementing
the same Cloudflare-shaped [`@mieweb/cloud`](../../README.md) contracts as
`@mieweb/cloud-local` — but over durable, networked infrastructure. The same
worker handler runs unchanged.

| Binding   | Driver         | Backend                              |
| --------- | -------------- | ------------------------------------ |
| D1        | `libsql`       | libSQL/sqld (SQLite + FTS5)          |
| Vectorize | `libsql-vec`   | libSQL native vectors (`vector_distance_cos`) |
| R2        | `s3`           | S3-compatible (MinIO, SeaweedFS, AWS S3) |
| KV        | `valkey`       | Valkey / Redis                       |
| Queues    | `valkey-queue` | Valkey / Redis (list + delayed zset) |
| AI        | `ai`           | reused from `@mieweb/cloud-local` (Ollama) |
| Durable Objects | `inproc` | reused — single-node, best-effort    |

Importing the package registers its drivers into the shared driver registry, so
`createCloudEnv` dispatches `mieweb`-target bindings to them with no core changes.

## Configure

Copy the `targets.mieweb` block from [`mieweb.sample.jsonc`](./mieweb.sample.jsonc)
into the consuming app's `mieweb.jsonc`, then select it with
`mieweb --target mieweb <cmd>` (or set `"target": "mieweb"`).

## Develop / test against live infra

```sh
pnpm --filter @mieweb/cloud-os infra:up     # libSQL + MinIO + Valkey (docker compose)
pnpm --filter @mieweb/cloud-os test         # live conformance suite
pnpm --filter @mieweb/cloud-os infra:down   # tear down (-v removes volumes)
```

The conformance suite ([`test/conformance.os.test.mjs`](./test/conformance.os.test.mjs))
runs the same contracts as the local suite; it self-skips any service that
isn't reachable, so `pnpm -r test` stays green without Docker.

## Notes

- **Durable Objects** are single-node (in-process) for now; cross-node DO
  coordination on os is a future enhancement.
- libSQL keeps the application's SQL — including FTS5 — verbatim, which is why
  it's the DB choice over a Postgres rewrite.
- Production should use real credentials/TLS; the docker-compose defaults are
  dev-only.
