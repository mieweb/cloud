# `@mieweb/cloud-local`

Local / Node adapters for the mieweb cloud portability layer, plus the Node host
harness and migration runner that `mieweb --target local` uses.

| Contract | Adapter |
| --- | --- |
| D1 | SQLite (`better-sqlite3`, FTS5 preserved) |
| R2 | filesystem |
| KV | in-memory |
| Queues | in-process |
| Durable Objects | in-process registry |
| Vectorize | `sqlite-vec` |
| Workers AI | explicit `UnsupportedBindingError` unless a model backend is configured |
| Containers | explicit `UnsupportedBindingError` (adapter planned) |

Other runtimes plug in through the driver registry:
`registerDriver(name, factory)` — this is how `@mieweb/cloud-os` adds libSQL,
S3, and Valkey.

**Status: 0.x — the API may change between minor versions.**

Full documentation lives in the
[repository README](https://github.com/mieweb/cloud#readme).
