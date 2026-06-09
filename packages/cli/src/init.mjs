/**
 * `mieweb init [dir]` — scaffold a new mieweb project.
 *
 * Stamps out a minimal, runnable worker plus the three config surfaces the
 * layer expects:
 *
 *   wrangler.jsonc          source of truth for bindings (Cloudflare shapes)
 *   mieweb.jsonc            off-Cloudflare driver hints + default target
 *   worker/index.mjs        a normal `export default { fetch }` worker
 *   package.json            wired to @mieweb/cli with dev/deploy scripts
 *   .gitignore              ignores .data/ + node_modules
 *
 * Mirrors `wrangler init` / `npm create cloudflare`: it only writes files, then
 * prints next steps. It never installs deps or touches anything outside the
 * target directory.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

/**
 * @param {string[]} args  args after the `init` verb (e.g. ['my-app'])
 * @param {{ cwd?: string }} [opts]
 * @returns {number} exit code
 */
export function runInit(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();

  // First non-flag arg is the target directory; default to '.' (cwd).
  const dirArg = args.find((a) => !a.startsWith('-')) ?? '.';
  const force = args.includes('--force') || args.includes('-f');

  const targetDir = resolve(cwd, dirArg);
  const projectName = sanitizeName(basename(targetDir));

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
    console.error(
      `mieweb init: "${dirArg}" already exists and is not empty. ` +
        `Pass --force to scaffold into it anyway.`,
    );
    return 1;
  }

  mkdirSync(join(targetDir, 'worker'), { recursive: true });

  /** @type {Array<[string, string]>} */
  const files = [
    ['package.json', packageJson(projectName)],
    ['wrangler.jsonc', wranglerJsonc(projectName)],
    ['mieweb.jsonc', miewebJsonc()],
    ['worker/index.mjs', workerIndex()],
    ['.gitignore', gitignore()],
    ['README.md', readme(projectName)],
  ];

  for (const [rel, contents] of files) {
    const dest = join(targetDir, rel);
    if (existsSync(dest) && !force) {
      console.error(`mieweb init: refusing to overwrite ${rel} (use --force)`);
      return 1;
    }
    writeFileSync(dest, contents);
  }

  const where = dirArg === '.' ? '.' : dirArg;
  process.stdout.write(
    [
      `Created a mieweb project in ${where}`,
      '',
      'Next steps:',
      ...(dirArg === '.' ? [] : [`  cd ${dirArg}`]),
      '  npm install            # or: pnpm install',
      '  npx mieweb --target local dev',
      '',
      'Then deploy to Cloudflare with:',
      '  npx mieweb deploy',
      '',
    ].join('\n'),
  );
  return 0;
}

/** npm package names must be lowercase, url-safe. */
function sanitizeName(name) {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return cleaned || 'mieweb-app';
}

function packageJson(name) {
  return (
    JSON.stringify(
      {
        name,
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'mieweb --target local dev',
          'dev:cf': 'mieweb dev',
          deploy: 'mieweb deploy',
        },
        devDependencies: {
          '@mieweb/cli': '^0.1.0',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function wranglerJsonc(name) {
  return `{
  // wrangler.jsonc is the source of truth for your bindings. On the cloudflare
  // target \`mieweb\` forwards verbatim to wrangler; other targets read these
  // shapes and back each binding with an adapter (see mieweb.jsonc).
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "worker/index.mjs",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // A starter D1 + KV binding. Add R2/Queues/Durable Objects/Vectorize/AI as
  // you need them — every contract surface is portable across targets.
  "d1_databases": [
    { "binding": "DB", "database_name": "${name}", "database_id": "local-${name}" }
  ],
  "kv_namespaces": [{ "binding": "CACHE", "id": "local-${name}-cache" }]
}
`;
}

function miewebJsonc() {
  return `{
  // Off-Cloudflare driver hints. wrangler.jsonc stays the source of truth for
  // WHICH bindings exist; this sidecar only says which adapter backs each one
  // per target. Pick a target with \`mieweb --target <t> dev\` or the field below.
  "$schema": "node_modules/@mieweb/cli/mieweb-config.schema.json",
  "wrangler": "./wrangler.jsonc",
  "target": "local",
  "targets": {
    // local: in-process Node adapters, zero external services.
    "local": {
      "port": 8787,
      "bindings": {
        "DB": { "driver": "sqlite", "path": ".data/local/d1.sqlite" },
        "CACHE": { "driver": "memory" }
      }
    },

    // mieweb (os.mieweb.org): libSQL + Valkey. Bring the backing services up
    // with the docker-compose.yml from @mieweb/cloud-os.
    "mieweb": {
      "port": 8787,
      "bindings": {
        "DB": { "driver": "libsql", "url": "http://localhost:8080" },
        "CACHE": { "driver": "valkey", "host": "127.0.0.1", "port": 6379, "namespace": "app" }
      }
    }
  }
}
`;
}

function workerIndex() {
  return `/**
 * A normal Cloudflare worker — \`export default { fetch }\`. The same module runs
 * unchanged on every target:
 *
 *   cloudflare : \`mieweb dev\` (wrangler / Miniflare) with native bindings
 *   local      : \`mieweb --target local dev\` (SQLite + in-memory KV)
 *   mieweb/os  : \`mieweb --target mieweb dev\` (libSQL + Valkey)
 *
 * @typedef {Object} Env
 * @property {D1Database} DB
 * @property {KVNamespace} CACHE
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return json({ ok: true, hint: 'try /hits' });
    }

    // /hits — a tiny D1 + KV example: count requests in D1, cache the last
    // count in KV. Touches two portable surfaces with no Cloudflare lock-in.
    if (url.pathname === '/hits') {
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at TEXT)',
      ).run();
      await env.DB.prepare('INSERT INTO hits (at) VALUES (?)')
        .bind(new Date().toISOString())
        .run();
      const { results } = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM hits',
      ).all();
      const n = results?.[0]?.n ?? 0;
      await env.CACHE.put('last-count', String(n));
      return json({ hits: n });
    }

    return json({ error: 'not found' }, 404);
  },
};
`;
}

function gitignore() {
  return `node_modules/
.data/
.wrangler/
*.log
`;
}

function readme(name) {
  return `# ${name}

A [mieweb](https://github.com/mieweb/cloud) project — one worker, portable across
Cloudflare, local Node, and os.mieweb.org.

## Develop

\`\`\`sh
npm install

# local Node adapters (SQLite + in-memory KV), no external services
npx mieweb --target local dev

# Cloudflare (wrangler / Miniflare)
npx mieweb dev
\`\`\`

Hit a route:

\`\`\`sh
curl localhost:8787/hits
\`\`\`

## Deploy

\`\`\`sh
npx mieweb deploy        # forwards to wrangler on the cloudflare target
\`\`\`
`;
}
