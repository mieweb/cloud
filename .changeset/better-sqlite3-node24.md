---
"@mieweb/cloud-adapters": patch
---

Bump the optional `better-sqlite3` peer to ^13 so the `local` target's D1 and
Vectorize adapters work on Node 24 (11.x aborted with
`Assertion failed: (env) != nullptr` during GC). Verified on Node 22 and 24.
