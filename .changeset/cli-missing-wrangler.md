---
"@mieweb/cli": patch
---

Don't crash with a stack trace when wrangler isn't installed: wrangler-delegated commands on the cloudflare target now print "wrangler binary not found…" and exit 1, and `mieweb --version` still prints the mieweb version (exit 0).
