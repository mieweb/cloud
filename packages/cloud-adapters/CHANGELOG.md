# @mieweb/cloud-adapters

## 0.2.2

### Patch Changes

- 0dfa39b: Upgrade `@hono/node-server` to ^2 (up to 2.3x faster request handling in the
  Node host harness; `serve()` API unchanged). Drops Node 18, which `engines`
  already excluded.

## 0.2.1

### Patch Changes

- 22d50b4: Bump the optional `better-sqlite3` peer to ^13 so the `local` target's D1 and
  Vectorize adapters work on Node 24 (11.x aborted with
  `Assertion failed: (env) != nullptr` during GC). Verified on Node 22 and 24.

## 0.2.0

### Minor Changes

- e160213: Consolidate six packages into three, split by what a consumer must install:

  - `@mieweb/cloud` now contains the contracts (formerly `@mieweb/cloud-types`) and
    the `mieweb:workers` shim at `@mieweb/cloud/workers` (formerly
    `@mieweb/cloud-workers`). Still zero dependencies.
  - `@mieweb/cloud-adapters` replaces `@mieweb/cloud-local` (`.`/`./local`) and
    `@mieweb/cloud-os` (`./os`). Backend SDKs (`better-sqlite3`, `sqlite-vec`,
    `@libsql/client`, `@aws-sdk/client-s3`, `ioredis`) are optional peer
    dependencies — install only what your target needs.
  - `mieweb init` now writes the `mieweb:workers` alias into `wrangler.jsonc`.

  Migration: point the `mieweb:workers` alias (`wrangler.jsonc` `alias`,
  `tsconfig.json` `paths`) at `@mieweb/cloud/workers`; replace
  `@mieweb/cloud-local/*` imports with `@mieweb/cloud-adapters/*` and
  `@mieweb/cloud-os` with `@mieweb/cloud-adapters/os`. App code importing from
  `@mieweb/cloud` or `mieweb:workers` is unchanged.
