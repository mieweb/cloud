# @mieweb/cli

## 0.3.1

### Patch Changes

- Updated dependencies [4eeadf2]
  - @mieweb/deploy-wrangler@0.3.1
  - @mieweb/cloud-adapters@0.3.1
  - @mieweb/deploy-contract@0.3.1

## 0.3.0

### Minor Changes

- b3a9226: Introduce the deploy-provider contract and a Cloudflare reference provider.

  - `@mieweb/deploy-contract` (new): a minimal, provider-agnostic `DeployProvider`
    TypeScript interface plus a conformance test-kit. The CLI consumes it; deploy
    backends implement it. No wrangler.jsonc field names, backend API shapes, or
    resource-URI grammar leak into the contract — those stay provider details.
    Includes an auth surface: optional `login`/`logout`/`whoami` verbs, an
    `AuthStatus` type, and an `AuthError` (the control-plane analogue of
    `UnsupportedBindingError`) providers throw on backend 401/403 so the CLI can
    prompt the user to log in. Credentials never travel through the contract — a
    provider reads them from the environment via `createProvider(env)`, and
    `targetConfig` is documented as non-secret. Runtime values (`AuthError`,
    `RESOURCE_KINDS`) ship as plain ESM so bare-`node` providers can import them
    without a TypeScript loader; declarations use `.d.mts` and the factory env
    type is a dependency-free record (no `@types/node` required).
  - `@mieweb/deploy-wrangler` (new): the Cloudflare **reference** provider. Wraps
    the pinned `wrangler` binary (`deploy`/`dev`/`tail`, plus
    `login`/`logout`/`whoami` mapped to their wrangler equivalents) and reads
    resource handles back from the manifest — reloading `wrangler.jsonc` after a
    deploy so auto-provisioned, written-back ids are surfaced. Deploy failures that
    are actually auth failures map to `AuthError`; a signal-killed child is treated
    as failure; `dev` exposes a `closed` promise so a crashed dev returns instead
    of hanging. It runs the project's own `wrangler` (or `MIEWEB_REAL_WRANGLER`). It is the canonical implementation other
    providers (opensource-server, future AWS/GCP) are measured against via the
    test-kit.
  - `@mieweb/cli`: `deploy`/`dev`/`tail`/`login`/`logout`/`whoami`/`destroy` now
    route through a resolved `DeployProvider`. Cloudflare resolves to the wrangler
    reference provider; other targets can name a provider package in
    `mieweb.jsonc` (`targets[t].provider`). Targets without a provider fall
    through to the existing behavior unchanged. The data-plane `bindings` bag is
    stripped from the provider's `targetConfig`, and `AuthError` is surfaced
    with an actionable "run `mieweb login`" hint.

### Patch Changes

- Updated dependencies [b3a9226]
- Updated dependencies [0dfa39b]
  - @mieweb/deploy-contract@0.3.0
  - @mieweb/deploy-wrangler@0.3.0
  - @mieweb/cloud-adapters@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [22d50b4]
  - @mieweb/cloud-adapters@0.2.1

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

### Patch Changes

- Updated dependencies [e160213]
  - @mieweb/cloud-adapters@0.2.0
