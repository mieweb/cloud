---
"@mieweb/deploy-wrangler": patch
---

Republish: `@mieweb/deploy-wrangler@0.3.0` was published with an unresolved `workspace:*` dependency on `@mieweb/deploy-contract` and can't be installed (nor can `@mieweb/cli@0.3.0`, which depends on it). Publishing with npm instead of pnpm is now refused, and CI checks packed tarballs for `workspace:` ranges.
