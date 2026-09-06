# Workers runtime smoke test

Boots `hostAgent()` on workerd via Miniflare with real D1, Queues, and Durable
Object bindings, using a stub runtime so no model provider is needed.

This exists because the local (better-sqlite3) and mieweb (libSQL) backends are
more permissive than D1 in places. Anything that passes conformance on those
two can still fail on Cloudflare — `initSchema()` did.

```sh
npx wrangler dev -c wrangler.jsonc --port 8799 --local
```

Then, against `http://localhost:8799`:

| Request | Exercises |
|---------|-----------|
| `GET /health` | worker boot, D1 schema init |
| `GET /v1/sessions/smoke-1/status` | Durable Object + D1 read |
| `POST /v1/events` | D1 write |
| `POST /v1/sessions/smoke-1/messages` | synchronous turn through the DO |
| `POST /v1/sessions/smoke-2/enqueue` | Queues producer → consumer → DO |

Vectorize and AI bindings are omitted because Miniflare does not emulate them;
`hostAgent()` treats both as optional.
