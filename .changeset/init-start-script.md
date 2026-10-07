---
"@mieweb/cli": patch
"@mieweb/cloud-adapters": patch
---

`mieweb init` adds a `start` script (`mieweb --target mieweb dev`), which the os.mieweb.org cloud image runs via `npm start`. The Node host harness now listens on `$PORT` when set.
