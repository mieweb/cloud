---
"@mieweb/deploy-contract": minor
"@mieweb/deploy-wrangler": minor
"@mieweb/cli": minor
---

Introduce the deploy-provider contract and a Cloudflare reference provider.

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
  type is a dependency-free record (no `@types/node` required). Also exports a
  shared string-aware `./jsonc` parser used by the CLI and providers.
- `@mieweb/deploy-wrangler` (new): the Cloudflare **reference** provider. Wraps
  the pinned `wrangler` binary (`deploy`/`dev`/`tail`, plus
  `login`/`logout`/`whoami` mapped to their wrangler equivalents) and reads
  resource handles back from the manifest — reloading `wrangler.jsonc` after a
  deploy so auto-provisioned, written-back ids are surfaced. Deploy failures that
  are actually auth failures map to `AuthError`; a signal-killed child is treated
  as failure; `dev` exposes a `closed` promise so a crashed dev returns instead
  of hanging. `wrangler` is an optional peer dependency (the `MIEWEB_REAL_WRANGLER`
  escape hatch also satisfies it). It is the canonical implementation other
  providers (opensource-server, future AWS/GCP) are measured against via the
  test-kit.
- `@mieweb/cli`: `deploy`/`dev`/`tail`/`login`/`logout`/`whoami`/`destroy` now
  route through a resolved `DeployProvider`. Cloudflare resolves to the wrangler
  reference provider; other targets can name a provider package in
  `mieweb.jsonc` (`targets[t].provider`). Targets without a provider fall
  through to the existing behavior unchanged. Provider context is recursively
  redacted of secrets before it reaches a provider, and `AuthError` is surfaced
  with an actionable "run `mieweb login`" hint.
