# `@mieweb/cli` — the `mieweb` command

Target-aware wrapper over `wrangler`. On the `cloudflare` target (default)
most commands are forwarded verbatim to `wrangler`; the deploy lifecycle verbs
(`deploy`, `dev`, `tail`, plus `login`/`logout`/`whoami`, and `destroy`) go
through a pluggable **deploy provider** (`@mieweb/deploy-contract`) whose
Cloudflare reference implementation still delegates to `wrangler` — adding
structured logging, resource reporting, and auth-aware error handling around it.
On the `mieweb` target (os.mieweb.org) `deploy`, `destroy`, `login`, `logout`
and `whoami` go through the bundled opensource-server provider
(`@mieweb/os-cloud-provider`; configure `targets.mieweb.siteId` /
`instanceUrl`, auth via `MIEWEB_OS_TOKEN`). Verbs a provider doesn't implement
(`dev`, `tail` on `mieweb`) fall back to the Node host harness, which also runs
everything on `local`. Any target can override its provider with
`targets[t].provider`. See
the [root README](../../README.md) for the full model.

```sh
mieweb [--target <cloudflare|local|mieweb>] <command> [...args]
```

## Images (Cloudflare Containers)

Build container images once, distribute them with **skopeo**
(see [container-plan.md](../../container-plan.md)).

**Prerequisites:** `skopeo` plus a builder — `buildah` (preferred) or `docker`.

```sh
brew install skopeo buildah        # macOS
# apt/dnf install skopeo buildah   # Linux
```

The CLI reads the `containers` array in `wrangler.jsonc` (class → Dockerfile)
and the per-target `registry` block in `mieweb.jsonc`:

```jsonc
// mieweb.jsonc
{
  "targets": {
    "mieweb": {
      "registry": {
        "url": "cr.os.mieweb.org",
        "project": "cloud-apps",
        "username": "robot$cloud-apps+ci",
        "authFile": "~/.config/mieweb/registry-auth.json"
      }
    }
  }
}
```

### Commands

```sh
mieweb images build                  # build every containers[] image (buildah/docker)
mieweb images push --target mieweb   # build + skopeo copy → registry, pin digests
mieweb images push                   # cloudflare target: delegates to `wrangler containers push`
mieweb images inspect CONVERTER      # skopeo inspect by binding name or class name
mieweb images status                 # lockfile pins vs. what's live in the registry

mieweb registry login --target mieweb    # skopeo login (writes authFile; password prompted, never argv)
mieweb registry logout --target mieweb
```

### Conventions

- **Naming:** `docker://<registry.url>/<project>/<class_name lowercased>:<git short SHA>`,
  plus a `latest` moving tag. `project` defaults to the wrangler app `name`.
- **Lockfile:** pushes pin the manifest digest per class per target in
  `.mieweb/images.lock.json` (commit it — it's what makes deploys reproducible).
  `mieweb images status` reports drift between the pin and the registry's `latest`.
- **Auth:** prefer `authFile` (written by `mieweb registry login`) over inline
  credentials; secrets are never passed on the command line or logged.
  Harbor robot accounts (`robot$project+name`) are the expected CI identity.
- **Cloudflare:** the managed registry is wrangler's job — `images push` on the
  `cloudflare` target hands off to `wrangler containers push` rather than
  reimplementing its auth with skopeo.
