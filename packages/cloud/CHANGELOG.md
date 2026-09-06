# @mieweb/cloud

## 0.2.2

## 0.2.1

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
