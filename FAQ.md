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
ecosystem's **canonical OCI layer**: a content-addressed image store (a standard
OCI image-layout directory on disk), registry transports, and pluggable
"realizers" that attach execution — a bash isolate or a hardened Docker/Podman
container — to stored state. Its model inverts Docker's: the writable workspace is
the versioned, pushable artifact; the image is just a base.

`@mieweb/cloud` is a *consumer* of that layer, not a competitor. For the
Containers surface it uses artipod where artipod is good — storing, inspecting,
pushing and pulling images, and driving a local container runtime — and keeps
buildah/docker for the one thing artipod deliberately doesn't do: executing a
Dockerfile. Today the CLI still shells out to skopeo for transport; the migration
to `@artipod/core/oci`, and the semantic gap between artipod's sandbox realizer
and a Cloudflare `Container` service, are worked through in
[container-plan.md → Relationship to artipod](container-plan.md#relationship-to-artipod).
