# @mieweb/test-app

A tiny worker that exercises **every** `@mieweb/cloud` contract surface, used to
prove the portability layer works identically on each target.

> One worker. One set of HTTP assertions. Three runtimes.

## Layout

| Path | What it is |
| ---- | ---------- |
| [`worker/index.mjs`](worker/index.mjs) | The worker. Each route touches exactly one binding (`/kv`, `/db/items`, `/r2`, `/queue`, `/counter`, `/vector`, `/ai/embed`) plus the `Counter` Durable Object and a queue consumer. The same `export default { fetch, queue, scheduled }` runs on every target. |
| [`wrangler.jsonc`](wrangler.jsonc) | The canonical Cloudflare config (all bindings). |
| [`wrangler.local-dev.jsonc`](wrangler.local-dev.jsonc) | Offline `wrangler dev` config (Cloudflare reference minus AI + Vectorize, which need credentials/remote). |
| [`mieweb.jsonc`](mieweb.jsonc) | Off-Cloudflare driver hints for the `local` and `mieweb` targets. |
| [`harness/surfaces.mjs`](harness/surfaces.mjs) | The shared, target-agnostic HTTP contract checks. |
| [`harness/run.mjs`](harness/run.mjs) | The cross-target runner (`--target cf\|local\|docker\|all`). |
| [`test/local.test.mjs`](test/local.test.mjs) | `node --test` entry: boots the `local` target in-process and runs the checks (part of `pnpm -r test`). |

## Run it

```sh
pnpm --filter @mieweb/test-app check:local    # in-process Node adapters (no services)
pnpm --filter @mieweb/test-app check:docker   # mieweb/os: brings up libSQL + MinIO + Valkey
pnpm --filter @mieweb/test-app check:cf        # Cloudflare via `wrangler dev` (Miniflare)
pnpm --filter @mieweb/test-app check:all       # all available targets
```

Flags: `--keep-infra` (leave the docker stack up), `--strict-cf` (fail instead
of skip when wrangler can't run).

## How a surface "skips"

Targets can't always provide every binding (Workers AI needs a model backend;
Cloudflare local dev can't reach Vectorize/AI without credentials). Those routes
answer `501 { skipped: true }` and the assertions record a skip instead of a
failure — so the **same** suite passes on all three targets while still strictly
asserting every surface a target *does* support.
