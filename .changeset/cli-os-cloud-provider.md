---
"@mieweb/cli": minor
---

`--target mieweb` now deploys through the opensource-server provider (`@mieweb/os-cloud-provider`, bundled as a dependency). Verbs a provider doesn't implement (`dev`, `tail`) fall back to the Node host harness instead of erroring.

Providers can now write back settings they resolved interactively (e.g. the os.mieweb.org site picked at the prompt) via `DeployContext.persistTargetConfig`; the CLI edits `mieweb.jsonc` in place, keeping comments.
