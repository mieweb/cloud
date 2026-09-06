# Containers surface — plan

Add Cloudflare **Containers** as a portable surface of the `@mieweb/cloud` contract,
cheap parts first. A Container on Cloudflare is a Durable-Object-controlled Linux
container (`class MyContainer extends Container`, bound via the normal
`durable_objects.bindings` block plus a `containers` array in `wrangler.jsonc`), so
the contract addition is small — the real work is image distribution and the
non-Cloudflare runtime, which we defer.

**Key choices**

- **skopeo for image movement — today.** No Docker daemon needed to *distribute*: the CLI
  builds once (buildah/docker, whichever is present) and uses
  `skopeo copy` / `skopeo inspect` to push the OCI image to each target's registry
  (Cloudflare's managed registry via `wrangler containers push`, Harbor for the
  `mieweb` target, `oci-archive:`/`containers-storage:` for local caching).
  The intended successor for the transport/store half is `@artipod/core/oci`; see
  [Relationship to artipod](#relationship-to-artipod). Dockerfile *builds* stay on
  buildah/docker either way.
- **Harbor + Forgejo live in the opensource-server standalone cluster.** The
  `mieweb` target's registry endpoint is Harbor; Forgejo Actions is the eventual
  CI that builds + skopeo-copies images. This plan only reserves the config
  surface for that (registry URL + creds in `mieweb.jsonc` targets block); the
  cluster deploy itself is tracked in opensource-server, not here.
- **Fail-loudly first.** Until a real adapter exists, non-Cloudflare targets
  surface `UnsupportedBindingError` through the existing
  `createUnsupportedBinding` proxy — same pattern as Vectorize/AI on `local`.

---

## Relationship to artipod

[`@artipod/core`](https://github.com/mieweb/artipod) (`npx artipod`) is the
mieweb ecosystem's canonical layer for OCI manipulation: a content-addressed blob
store whose on-disk form is a standard OCI image-layout directory, registry
transports (push/pull missing-digests-only, resumable, relay-friendly), and
"realizers" that attach execution to stored state. Where this plan shells out to
skopeo or drives Docker directly, artipod is the intended replacement — with two
honest caveats spelled out below.

### What maps onto what

| This plan | artipod | Verdict |
| --- | --- | --- |
| `detectBuilder()` → `buildah bud` / `docker build` | none — artipod imports directory trees and commits pod uppers; it has no Dockerfile builder | **keep** buildah/docker; bridge the result into an OCI layout (`buildah push oci:` / `docker save`) |
| `pushImage()` → `skopeo copy … docker://harbor/…` | `@artipod/core/oci` transports | **replace** — drops the skopeo binary dependency |
| `inspectImage()` → `skopeo inspect` | manifest/digest read straight from the OCI store | **replace** |
| `registry login/logout` → `skopeo login` + authFile | artipod transport auth | **verify** it honors `containers-auth.json` / Harbor robot accounts before switching |
| `.mieweb/images.lock.json` digest pins | content-addressed refs are the native model | **simplify** — lockfile becomes a view over store digests |
| M4 `container-docker.mjs` (skopeo pull → docker run → proxy `fetch()`) | `@artipod/core/docker` realizer (socket auto-detection, `dockerode`, hardening) + `oci` pull | **build on** — the largest win, with the semantic gap below |
| `mieweb` target "cluster runtime TBD" | `@artipod/core/server` pull-through cache + manager hosting | candidate answer for single-node `os.mieweb.org` |

### Caveat 1 — no build step

Cloudflare containers are Dockerfile-defined (`containers[].image: "./Dockerfile"`).
artipod's model is *import a tree* or *commit a pod*; it never executes a
Dockerfile. Something must — buildah, docker, or `wrangler containers build`. The
bridge is cheap: build → export as `oci:` layout → artipod store/push.

Related: artipod commits produce **volume images**
(`application/vnd.artipod.volume.v1+json` config). Runtime images need the plain
OCI image config (`Cmd`/`Entrypoint`). Confirm the transport passes arbitrary
manifests through unmodified rather than only its own media type.

### Caveat 2 — realizer semantics ≠ Cloudflare Container semantics

A *realizer* is artipod's term for the thing that turns a pod's declarative mount
table into something executable (bash isolate, Docker/Podman, later
container2wasm). The Docker realizer is built for "run a command against
versioned state, safely, offline". Cloudflare Containers are "give this Durable
Object a sidecar HTTP service". The defaults are nearly inverse:

| | artipod Docker realizer | Cloudflare `Container` (what M4 emulates) |
| --- | --- | --- |
| Unit of work | run a command, capture output (`pod.executeCommand(...)`) | long-lived service; `getContainer(ns, id).fetch(req)` |
| Image | artipod's own hardened Alpine image; the pod is the payload | the app's image; the image *is* the workload |
| Network | `NetworkMode: none` by default | must listen on `defaultPort`; usually needs egress |
| Rootfs | read-only, `CapDrop ALL`, noexec tmpfs, seccomp | whatever the app's Dockerfile expects |
| Lifecycle | start → exec → stop; the writable upper is the durable artifact | start on first `fetch`, idle out after `sleepAfter`, `onStart`/`onStop`/`onError`; state is disposable |
| Identity | pod id / OCI ref | DO id → one container instance |
| Mounts | the whole point | essentially none |

Two ways to close the gap in M4:

1. **Wrap artipod's low-level Docker plumbing** (socket discovery, create/start/stop)
   but override the hardening profile — enable networking, use the app's image,
   skip the mount table — and add the Cloudflare lifecycle shim (port proxy,
   `sleepAfter` timer, DO-id → container-name mapping) here. Ships without touching
   artipod's "do not regress" hardening guarantees.
2. **Propose a second realizer upstream** — a *service realizer* whose contract is
   *image + port + idle timeout → fetch handler*, alongside the sandbox realizer.
   Makes artipod genuinely canonical for both "run a command in a pod" and "host a
   container service"; M4 becomes a thin consumer. Belongs as an issue on
   `mieweb/artipod`, linked here once filed.

### Other things to weigh

- **Dependency weight.** `@mieweb/cli` is zero-dependency shell-outs today;
  artipod carries ZenFS, just-bash, crypto/keyring, and agent tooling. Check that
  `@artipod/core/oci` imports without dragging the browser/agent stack.
- **Version coupling.** artipod is 0.10.x and moving fast. Both repos are ours,
  but adopting it makes M2/M4 track its API.

### Sequencing

- **Now:** M2 lands on skopeo as written.
- **Next:** swap `pushImage`/`inspectImage` to `@artipod/core/oci` behind the
  existing function signatures in `packages/cli/src/images.mjs` (already isolated);
  keep the buildah → OCI-layout bridge.
- **M4:** build the adapter on `@artipod/core/docker` + `oci` pull, choosing option
  1 or 2 above.

---

## Use case: `myapp` — a doc-conversion app that needs a container

The story every doc/README anchors to. A dev is building **myapp**: users upload
`.docx` files, myapp serves them back as PDFs. The upload/list/serve logic is a
perfect Worker (R2 + D1 + KV), but the conversion needs **LibreOffice** — a
multi-GB Linux userland that can never run in a V8 isolate on *any* of our
targets. That's the container.

**Shape of myapp:**

```
myapp/
├── wrangler.jsonc        # bindings: DOCS (R2), DB (D1), CONVERTER (container)
├── mieweb.jsonc          # targets: local, mieweb (Harbor registry block)
├── worker/index.mjs      # fetch handler + `class Converter extends Container`
└── converter/
    ├── Dockerfile        # FROM debian + libreoffice + a tiny HTTP shim on :4000
    └── serve.mjs         # POST /convert  (docx in → pdf out)
```

The worker stays the brains; the container is a dumb HTTP appliance:

```js
// worker/index.mjs
import { Container, getContainer } from '@cloudflare/containers';

export class Converter extends Container {
  defaultPort = 4000;
  sleepAfter = '5m';          // LibreOffice is heavy — sleep when idle
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/convert') {
      const docx = await env.DOCS.get(url.searchParams.get('key'));
      // one container instance per user keeps sessions warm but isolated
      const converter = getContainer(env.CONVERTER, url.searchParams.get('user'));
      const pdf = await converter.fetch('http://converter/convert', {
        method: 'POST', body: docx.body,
      });
      await env.DOCS.put(`pdf/${url.searchParams.get('key')}.pdf`, pdf.body);
      return new Response('converted');
    }
    // …upload/list/serve routes: plain R2/D1, already portable today
  },
};
```

**The dev's day, per milestone:**

| Dev action | Today | After M0–1 | After M2–3 | After M4 |
| --- | --- | --- | --- | --- |
| Write the code above | types don't exist | ✅ compiles against `CloudContainerNamespace` | ✅ | ✅ |
| `mieweb --target cloudflare dev` / `deploy` | ✅ works already (wrangler native) | ✅ | ✅ | ✅ |
| `mieweb --target local dev` — worker routes | ✅ | ✅ | ✅ | ✅ |
| `mieweb --target local dev` — hit `/convert` | crash at boot | clean `UnsupportedBindingError: CONVERTER on "local"` | same | ✅ container runs via local Docker |
| `mieweb images push --target mieweb` | — | — | ✅ buildah → skopeo → Harbor, digest locked | ✅ |
| `mieweb --target mieweb deploy` | — | — | image is in Harbor, runtime pending | ✅ end-to-end on the cluster |

The value proposition to sell in docs: **myapp's repo never mentions a target.**
The same `worker/` + `converter/Dockerfile` pair deploys to Cloudflare's edge or
the opensource-server cluster; only `mieweb.jsonc` (registry pointer) differs —
and CI (Forgejo Actions) does the build + skopeo copy so the dev usually never
runs `images push` by hand.

---

## Milestone 0 — Contract types (cheap, land now)

Reserve the surface in `@mieweb/cloud-types` so app code can be written against it.

- [x] Add `CloudContainerNamespace = DurableObjectNamespace` alias in
      `packages/cloud-types/src/index.ts` (a Container binding *is* a DO namespace).
- [x] Add `CloudContainerStub = DurableObjectStub` alias (what `getContainer()` returns).
- [x] Document the row in the primitive table in the file header:
      `Containers | DO-controlled Linux container | CloudContainerNamespace`.
- [x] Note in the doc comment that the app-side base class comes from
      `@cloudflare/containers` (`Container`) and is Cloudflare-shaped; portable
      adapters must emulate `ctx.container` (Milestone 4, deferred).
- [x] Update `packages/README.md` + root `README.md` binding tables with the new
      row, marked *cloudflare-only for now* (like Vectorize/AI were at POC time).

## Milestone 1 — Config schema + CLI awareness (cheap)

Teach the sidecar config and CLI that containers exist, without implementing them.

- [x] `packages/cli/mieweb-config.schema.json`: add `"docker"` (registry
      hint) and keep `"unsupported"` as valid drivers for a container binding; add
      per-target `registry` object: `{ url, project, username, password | authFile,
      insecureSkipTlsVerify? }` (Harbor for `mieweb`).
- [x] CLI (`packages/cli/src/config.mjs`): parse the `containers` array from
      `wrangler.jsonc` alongside `durable_objects.bindings` so container-backed DO
      bindings are identifiable (binding name → class name → image).
- [x] `mieweb --target cloudflare deploy/dev`: no behavior change — wrangler
      already handles `containers` natively; just make sure the CLI passes the
      config through untouched.
- [x] `mieweb --target local|mieweb dev`: on encountering a container-backed DO
      binding, wire `createUnsupportedBinding(name, target)` with a hint pointing
      at this plan ("container adapter not yet implemented").
- [x] Sample config: extend `packages/cloud-os/mieweb.sample.jsonc` and
      `packages/test-app/mieweb.jsonc` comments showing the reserved shape (commented out).

## Milestone 2 — skopeo image plumbing (cheap-ish, no runtime)

Image *distribution* only — nothing runs yet.

- [x] New CLI module `packages/cli/src/images.mjs`:
  - [x] `detectBuilder()` — prefer `buildah bud`, fall back to `docker build`;
        error clearly if neither is installed.
  - [x] `buildImage({ dockerfile, context, tag })` — build to local
        `containers-storage:` (buildah) or the Docker daemon.
  - [x] `pushImage({ tag, registry })` — `skopeo copy` from local storage to
        `docker://<registry.url>/<project>/<name>:<tag>`; support
        `--authfile`/creds from the target's `registry` config; never log secrets.
  - [x] `inspectImage(ref)` — `skopeo inspect` for digest pinning (record the
        digest so deploys are reproducible).
- [x] `mieweb images push --target mieweb` subcommand wiring in
      `packages/cli/src/index.mjs` (build + skopeo copy to Harbor).
- [x] For `--target cloudflare`, delegate to `wrangler containers push` (or
      `wrangler deploy`, which builds+pushes) — do **not** reimplement CF's
      managed-registry auth with skopeo initially; leave a TODO with the
      `wrangler containers images` escape hatch.
- [x] Digest-pin file (e.g. `.mieweb/images.lock.json`): image name → digest per
      target, written on push, read on deploy.
- [x] Docs: short "Images" section in `packages/cli` README (or root README)
      covering skopeo/buildah prerequisites (`brew install skopeo buildah` /
      distro packages).

## Milestone 3 — Harbor/Forgejo integration points (config only here)

The cluster work lives in **opensource-server**; this repo only consumes it.

- [x] Define the Harbor conventions the CLI assumes: project = app name,
      repo = container class name (lowercased), tag = git short SHA, plus a
      `latest` moving tag. Document in the plan/README.
- [x] Support robot-account auth (`username: 'robot$…'`) and `authFile` in the
      registry config; verify skopeo works against Harbor's token service.
      *(config + flags done; live-Harbor verification blocked on the cluster — see last box)*
- [x] Forgejo Actions workflow sketch (checked into the app repo, not executed
      here): build with buildah, `skopeo copy` to Harbor, run conformance.
      Add as a commented example under `packages/test-app/` or docs.
      → `packages/test-app/forgejo-images.example.yml`
- [ ] Coordinate with opensource-server: record the Harbor URL + CA expectations
      once the standalone cluster deploy lands (blocker for end-to-end testing;
      until then use a local Harbor via docker-compose or `skopeo copy` to
      `oci-archive:` in tests).

## Milestone 4 — Local/mieweb container runtime adapter (deferred, the expensive part)

Do **not** start until an app actually needs a container workload.

- [ ] `packages/cloud-local/src/adapters/container-docker.mjs`: implement
      `ctx.container` (start/stop/ports/monitor/signal) for the in-proc DO
      registry by driving a local Docker/Podman daemon; `sleepAfter` → idle
      timer → stop; `onStart`/`onStop`/`onError` hooks.
- [ ] Vendor or depend on `@cloudflare/containers` so the app's
      `class X extends Container` works unchanged off-Cloudflare.
- [ ] `mieweb` target: same adapter pointed at the cluster's container host
      (details TBD with opensource-server — possibly Podman over SSH or a k8s
      shim; decide then).
- [ ] Pull images from Harbor into local storage before start — via
      `@artipod/core/oci` (see [Relationship to artipod](#relationship-to-artipod));
      skopeo only as a fallback.
- [ ] Decide realizer strategy: wrap `@artipod/core/docker` plumbing with a local
      lifecycle shim, or land a service realizer upstream in artipod first.
- [ ] Conformance: add a container section to the test-app worker + harness
      (`packages/test-app/worker/index.mjs`, `harness/run.mjs`) exercising
      start, HTTP round-trip, sleepAfter, and stop across targets.
- [ ] Document divergences: ephemeral disk, SIGTERM→SIGKILL (15 min on CF),
      cold-start behavior, placement — local emulation is single-node
      best-effort, like the DO adapter.

---

## Documentation & proposed user-facing commands

What we ship as docs (root `README.md` "Containers" section + `packages/cli`
README "Images" section + sample-config comments), and the exact UX they show.

### App-side code (unchanged from Cloudflare)

The docs lead with the point of the whole repo: the app writes *stock
Cloudflare* container code and it stays portable.

```js
// worker/index.mjs — same on every target
import { Container, getContainer } from '@cloudflare/containers';

export class JobRunner extends Container {
  defaultPort = 4000;
  sleepAfter = '10m';
}

export default {
  async fetch(request, env) {
    return getContainer(env.JOB_RUNNER, 'session-42').fetch(request);
  },
};
```

```jsonc
// wrangler.jsonc — stays the single source of truth for bindings
{
  "containers": [{ "class_name": "JobRunner", "image": "./Dockerfile", "max_instances": 5 }],
  "durable_objects": { "bindings": [{ "class_name": "JobRunner", "name": "JOB_RUNNER" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["JobRunner"] }]
}
```

```jsonc
// mieweb.jsonc — sidecar: only registry + driver hints, per target
{
  "targets": {
    "mieweb": {
      "registry": {
        "url": "harbor.os.mieweb.org",
        "project": "cloud-apps",
        "username": "robot$cloud-apps+ci",
        "authFile": "~/.config/mieweb/harbor-auth.json"
      },
      "bindings": { "JOB_RUNNER": { "driver": "docker" } } // M4; "unsupported" until then
    }
  }
}
```

### Proposed commands

Image lifecycle (Milestone 2):

```sh
# Build the image(s) declared in wrangler.jsonc's `containers` array.
# Uses buildah if present, else docker. Tags with the git short SHA.
mieweb images build

# Build + skopeo-copy to the active target's registry, pin digest in
# .mieweb/images.lock.json. On --target cloudflare this delegates to
# `wrangler containers push` instead of skopeo.
mieweb images push --target mieweb          # → docker://harbor.os.mieweb.org/cloud-apps/jobrunner:<sha>
mieweb images push --target cloudflare     # → wrangler containers push

# Inspect what a target would run (skopeo inspect; shows digest, layers, arch).
mieweb images inspect --target mieweb JOB_RUNNER

# Show the digest lockfile vs. what's live in the registry.
mieweb images status
```

Registry auth (Milestone 3 — thin wrappers over skopeo's auth, never store
secrets in mieweb.jsonc committed files):

```sh
mieweb registry login --target mieweb       # → skopeo login harbor.os.mieweb.org (writes authFile)
mieweb registry logout --target mieweb
```

Dev & deploy (Milestones 1/4 — no new verbs, existing ones grow container
awareness):

```sh
mieweb --target cloudflare dev        # wrangler dev: builds + runs the image locally (needs Docker)
mieweb --target cloudflare deploy     # wrangler deploy: builds, pushes, rolls out — unchanged

mieweb --target local dev             # M1: boots; container binding throws UnsupportedBindingError on use
                                      # M4: skopeo-pulls image, docker-runs it, proxies getContainer().fetch()

mieweb --target mieweb deploy         # M4: push to Harbor + start on the cluster's container host
```

Debugging (documented, not built — these are the underlying tools):

```sh
wrangler containers list                              # live CF instances
wrangler containers ssh <class>                       # shell into a running CF container instance
docker exec -it mieweb-jobrunner-session-42 sh        # local-target instance (M4 naming convention)
skopeo inspect docker://harbor.os.mieweb.org/cloud-apps/jobrunner:latest
```

### Documentation checklist

- [x] Root `README.md`: add Containers row to the binding table + a short
      "Containers" section with the app-side example above and the
      target-support matrix (cloudflare ✅ / local ⏳ M4 / mieweb ⏳ M4).
- [x] `packages/cli` README (create if absent): "Images" section — prerequisites
      (`brew install skopeo buildah`), the `mieweb images …` and
      `mieweb registry …` commands, lockfile semantics, Harbor conventions
      (project/repo/tag naming from Milestone 3).
- [x] `packages/cloud-types/src/index.ts` header table row + doc comments
      (part of M0, listed here for completeness).
- [x] Sample configs (`packages/cloud-os/mieweb.sample.jsonc`,
      `packages/test-app/mieweb.jsonc`): commented-out registry + container
      binding blocks matching the example above.
- [ ] "Debugging containers" subsection: the `wrangler containers ssh` /
      `docker exec` / `skopeo inspect` table above, per target.
- [ ] Divergence notes (with M4): ephemeral disk, SIGTERM→SIGKILL window,
      cold starts, single-node local emulation.

---

## Sequencing / acceptance

| Milestone | Depends on | Done when |
| --------- | ---------- | --------- |
| 0 | — | types compile; READMEs updated; test-app unaffected |
| 1 | 0 | schema validates a container-reserved config; `local` dev throws `UnsupportedBindingError` on use, not at boot |
| 2 | 1 | `mieweb images push` builds and skopeo-copies to a registry; digest lockfile written |
| 3 | 2 + opensource-server Harbor | push to real Harbor with robot account succeeds from CI sketch |
| 4 | 2 + a real consumer app | conformance container section green on `local` (and `mieweb` when cluster host exists) |
