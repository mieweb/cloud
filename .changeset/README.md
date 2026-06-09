# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): small
markdown files describing changes that should land in the next release of the
`@mieweb/*` packages.

## Adding a changeset

When you make a change worth releasing, run:

```sh
pnpm changeset
```

Pick the affected packages and a bump type (patch / minor / major), and write a
one-line summary. Commit the generated file in this folder alongside your code.

All publishable `@mieweb/*` packages are versioned **together** (see `fixed` in
`config.json`), so one changeset bumps the whole set in lockstep. `@mieweb/test-app`
is private and ignored.

## Releasing (maintainers / CI)

On `main`, the release workflow runs `pnpm changeset version` to consume the
pending changesets (bumping versions + writing changelogs), then `pnpm changeset
publish` to push the tarballs to npm. See `.github/workflows/release.yml`.
