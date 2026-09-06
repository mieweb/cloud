# FAQ

## How does this compare to SST?

Different layers of the stack. SST is **infrastructure-as-code + deployment
framework**; `@mieweb/cloud` is a **runtime portability layer**.

| | `@mieweb/cloud` | SST (v3 / Ion) |
| --- | --- | --- |
| **Core job** | Make one Cloudflare-shaped codebase run unchanged on other runtimes (Node local, self-hosted libSQL/MinIO/Valkey, later AWS/GCP) | Define and deploy cloud infrastructure (mostly AWS, some Cloudflare) with typed components on a Pulumi/Terraform engine |
| **Abstraction level** | Runtime bindings/contracts (`CloudDatabase`, `CloudBucket`, `CloudKV`, `CloudQueue`, Durable Objects, …) | Provisioned resources (`sst.aws.Function`, `Bucket`, `Queue`, `Nextjs`, …) |
| **Source of truth** | `wrangler.jsonc` + `mieweb.jsonc` sidecar; no IaC engine at all | `sst.config.ts` — a full IaC program with state, diffs, deploys |
| **API shape** | Exactly Cloudflare's binding APIs (aliases of native types on Cloudflare; adapters elsewhere) | SST's own component API; at runtime you use each cloud's native SDK via `Resource.*` linking |
| **Reference platform** | Cloudflare, zero-overhead pass-through to `wrangler` | AWS-first |
| **Self-hosting** | A first-class target (`mieweb` → docker-compose of libSQL/MinIO/Valkey) | Not a goal — SST provisions managed cloud services |
| **Vendor lock-in stance** | Explicitly anti-lock-in at the *code* level (same handler everywhere, `UnsupportedBindingError` for honest gaps) | Portable *config*, but runtime code is still written against AWS SDKs (or Cloudflare APIs) — swapping clouds means rewriting handlers |

### The key philosophical difference

- **SST answers "how do I provision and deploy this?"** — it doesn't try to
  make your S3 code run against R2. If you write `new sst.aws.Bucket`, your
  handler uses the AWS SDK.
- **This project answers "how do I run this same code somewhere else?"** — it
  deliberately has *no* provisioning story. On Cloudflare it just shells out to
  `wrangler deploy`; on the `local`/`mieweb` targets you bring your own
  services (docker-compose).

### Where they overlap — or even compose

- Both wrap a dev loop (`mieweb dev` ≈ `sst dev`), but SST's is much richer
  (live lambda, console, secrets, multi-stage).
- SST supports Cloudflare, but as a *provisioning target*, not a compat layer —
  it won't emulate D1 on SQLite or KV on Valkey the way
  [`@mieweb/cloud-local`](packages/cloud-local) and
  [`@mieweb/cloud-os`](packages/cloud-os) do.
- They're not mutually exclusive: SST could provision AWS infrastructure while
  this layer's future AWS adapters keep the handler code Cloudflare-shaped.

The closest real analogues to this project are Nitro's `unstorage`/presets,
Miniflare/workerd emulation, or WinterCG-style runtime portability efforts —
not SST.

## How does this compare to OpenTofu (or Terraform)?

Even less overlap than with SST. OpenTofu is a **declarative provisioning
engine**: you describe cloud resources in HCL, it computes a plan against
recorded state and creates/updates/destroys infrastructure. It has no opinion
about — and no presence in — your application's runtime.

`@mieweb/cloud` is the opposite: it lives *entirely* at runtime and provisions
nothing. There is no state file, no plan/apply, no resource graph. Bindings are
declared in `wrangler.jsonc`, and the layer's job is to hand your worker an
`env` whose objects behave the same whether they're backed by Cloudflare, local
SQLite/filesystem, or self-hosted libSQL/MinIO/Valkey.

They compose naturally rather than compete: you could use OpenTofu to stand up
the backing services for the `mieweb` target (an S3 bucket, a Valkey instance,
a VM running libSQL) and point the `mieweb.jsonc` driver hints at them. This
repo just ships a `docker-compose.yml` instead because self-hosting is the
first-class case.

| | `@mieweb/cloud` | OpenTofu / Terraform |
| --- | --- | --- |
| **Phase** | Runtime (inside your worker's request path) | Provision time (before anything runs) |
| **Artifact** | Adapters implementing Cloudflare-shaped contracts | State file + resource graph |
| **Language** | Your application's JS/TS | HCL |
| **Changes what** | How `env.DB.prepare(...)` executes | What infrastructure exists |

## How does this relate to CloudFront (or Cloudflare's CDN)?

It doesn't — CloudFront is AWS's **CDN/edge-caching product**, a piece of
infrastructure, not a programming model. The name similarity is coincidental.

The genuinely related Cloudflare product is **Workers** (and its bindings: D1,
R2, KV, Queues, Durable Objects, Vectorize, Workers AI). This project treats
those *APIs* as the reference contract and re-implements them elsewhere. CDN
behavior — caching, edge routing, TLS termination — is out of scope: on the
`local`/`mieweb` targets you'd put whatever proxy/CDN you like in front of the
Node host harness, and on Cloudflare you get their edge as usual because the
CLI defers verbatim to `wrangler`.

(CloudFront's compute add-ons — Lambda@Edge / CloudFront Functions — are also
not a target here; a future AWS adapter tier would more likely map to Lambda +
Aurora/S3/DynamoDB/SQS than to the CDN layer.)

## How does this relate to artipod?

[artipod](https://github.com/mieweb/artipod) (`npx artipod`) is the mieweb
ecosystem's layer for **durable pod state and execution attached to that state**:
a content-addressed OCI image store, registry transports, and "realizers" that run
commands against a pod — a bash isolate or a hardened Docker/Podman container. Its
model inverts Docker's: the writable workspace is the versioned, pushable artifact;
the image is just a base.

The two projects share vocabulary (OCI, dockerode) but own different things, and
that boundary was settled deliberately in
[mieweb/artipod#56](https://github.com/mieweb/artipod/issues/56): artipod owns
running commands against pod state; **`@mieweb/cloud` owns application-container
lifecycle** — long-lived HTTP containers, Durable Object compatibility, routing,
deployment policy. So the Containers surface here does *not* build on artipod:
image distribution stays on skopeo, and the local/`mieweb` runtime adapter carries
its own lifecycle. The reasoning — why a "run a command in a sandbox" realizer and
a Cloudflare `Container` service have nearly inverse defaults — is in
[container-plan.md → Relationship to artipod](container-plan.md#relationship-to-artipod).

## Can I use a different CI than Forgejo Actions?

Yes. The CLI holds all the logic (`mieweb images push` builds, pushes, and pins
digests); CI is a thin wrapper that runs it — the repo's script-first rule. The
reference workflow, [packages/test-app/ci-images.example.yml](packages/test-app/ci-images.example.yml),
is three shell steps: `skopeo login`, `mieweb images push --target mieweb`, and
committing `.mieweb/images.lock.json`.

One fact that trips people up: **"GitHub Actions compatible" is not universal.**
Only the Gitea family reads that YAML:

| CI | Reads the example as-is? |
| --- | --- |
| Forgejo Actions, Gitea Actions, GitHub Actions | yes — same `on:`/`jobs:`/`steps:`/`uses:` model, built on `act_runner` |
| GitLab CI | no — `.gitlab-ci.yml`, `stages`/`script`/`image` |
| Woodpecker, Drone | no — `steps` with `image` + `commands`; plugins are containers |
| Jenkins, Buildkite, Tekton, Argo Workflows | no — Groovy / own YAML / k8s CRDs |

So if the cluster's CI changes to something outside the Gitea family, rewrite the
three shell steps in that CI's format — don't try to convert the YAML. Nothing in
`mieweb.jsonc`, `wrangler.jsonc`, or the CLI knows which CI ran it.
