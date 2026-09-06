---
"@mieweb/cloud-adapters": patch
---

Upgrade `@hono/node-server` to ^2 (up to 2.3x faster request handling in the
Node host harness; `serve()` API unchanged). Drops Node 18, which `engines`
already excluded.
