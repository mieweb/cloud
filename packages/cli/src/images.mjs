import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * `mieweb images …` / `mieweb registry …` — container image plumbing.
 *
 * Build once, distribute with skopeo (container-plan.md Milestone 2):
 *
 *   mieweb images build                       build every wrangler `containers` image
 *   mieweb images push [--target mieweb]      build + skopeo copy to the target registry
 *   mieweb images inspect <BINDING|class>     skopeo inspect what the target would run
 *   mieweb images status                      digest lockfile vs. registry
 *   mieweb registry login|logout              skopeo login against the target registry
 *
 * On `--target cloudflare`, push delegates to `wrangler containers push`
 * (Cloudflare's managed registry has its own auth dance) — skopeo is only used
 * for self-managed registries (Harbor on the `mieweb` target, local dev).
 *
 * Naming convention (container-plan.md Milestone 3):
 *   docker://<registry.url>/<registry.project>/<class_name lowercased>:<git short SHA>
 * plus a `latest` moving tag. Pushed digests are pinned in
 * `.mieweb/images.lock.json` so deploys are reproducible.
 */

/* ---------------------------------------------------------------- helpers */

/**
 * Run a command, inheriting stdio (interactive-friendly).
 * @param {string} cmd @param {string[]} args @param {{cwd?: string}} [opts]
 * @returns {Promise<number>}
 */
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    child.on('error', rej);
    child.on('exit', (code) => res(code ?? 0));
  });
}

/**
 * Run a command capturing stdout (for skopeo inspect etc.).
 * @param {string} cmd @param {string[]} args @param {{cwd?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function capture(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('exit', (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

/** @param {string} cmd */
async function commandExists(cmd) {
  const { code } = await capture('sh', ['-c', `command -v ${cmd}`]);
  return code === 0;
}

/**
 * Prefer buildah, fall back to docker. Determines both the build command and
 * the skopeo *source* transport for the built image.
 * @returns {Promise<{ name: 'buildah'|'docker', srcTransport: (ref: string) => string }>}
 */
export async function detectBuilder() {
  if (await commandExists('buildah')) {
    return { name: 'buildah', srcTransport: (ref) => `containers-storage:${ref}` };
  }
  if (await commandExists('docker')) {
    return { name: 'docker', srcTransport: (ref) => `docker-daemon:${ref}` };
  }
  throw new Error(
    'mieweb images: neither buildah nor docker found on PATH. ' +
      'Install one of them (and skopeo) — e.g. `brew install buildah skopeo`.',
  );
}

/** Git short SHA of HEAD (falls back to "dev" outside a repo). */
async function gitShortSha(cwd) {
  const { code, stdout } = await capture('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  return code === 0 ? stdout.trim() : 'dev';
}

/** Expand a leading `~` (authFile paths). @param {string} p */
function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * The wrangler `containers` entries that are locally built (image is a
 * Dockerfile path, not a remote ref).
 * @param {import('./config.mjs').MiewebConfig} config
 */
function buildableContainers(config) {
  return (config.containers ?? []).filter(
    (c) => typeof c.image === 'string' && !c.image.includes('://') && !c.image.startsWith('registry.'),
  );
}

/**
 * Registry config for the active target (mieweb.jsonc `targets.<t>.registry`).
 * @param {import('./config.mjs').MiewebConfig} config
 */
function registryFor(config) {
  const reg = config.targetConfig?.registry;
  if (!reg || typeof reg.url !== 'string') {
    throw new Error(
      `mieweb images: no registry configured for target "${config.target}". ` +
        `Add targets.${config.target}.registry = { url, project, … } to mieweb.jsonc.`,
    );
  }
  return reg;
}

/**
 * Fully-qualified repo ref (no tag) for a container class on a registry.
 * @param {{ url: string, project?: string }} reg
 * @param {Record<string, any>} c wrangler containers entry
 * @param {import('./config.mjs').MiewebConfig} config
 */
function repoRef(reg, c, config) {
  const project = reg.project ?? config.wrangler?.name ?? 'mieweb';
  return `${reg.url}/${project}/${String(c.class_name).toLowerCase()}`;
}

/** skopeo auth/TLS flags for a destination registry. @param {any} reg @param {'src'|'dest'} side */
function skopeoAuthFlags(reg, side) {
  const flags = [];
  if (reg.authFile) flags.push(`--${side}-authfile`, expandHome(reg.authFile));
  if (reg.insecureSkipTlsVerify) flags.push(`--${side}-tls-verify=false`);
  return flags;
}

/* ------------------------------------------------------------- lockfile */

/** @param {string} root */
function lockPath(root) {
  return resolve(root, '.mieweb/images.lock.json');
}

/** @param {string} root */
function readLock(root) {
  const p = lockPath(root);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {string} root @param {Record<string, any>} lock */
function writeLock(root, lock) {
  const p = lockPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(lock, null, 2)}\n`);
}

/* ------------------------------------------------------------ operations */

/**
 * Build one container image locally.
 * @param {{ name: 'buildah'|'docker' }} builder
 * @param {Record<string, any>} c wrangler containers entry
 * @param {string} root
 * @param {string} tag local ref, e.g. mieweb/jobrunner:abc1234
 */
export async function buildImage(builder, c, root, tag) {
  const dockerfile = resolve(root, c.image);
  const context = dirname(dockerfile);
  const args =
    builder.name === 'buildah'
      ? ['bud', '-f', dockerfile, '-t', tag, context]
      : ['build', '-f', dockerfile, '-t', tag, context];
  const code = await run(builder.name, args, { cwd: root });
  if (code !== 0) throw new Error(`mieweb images: ${builder.name} build failed for ${c.class_name} (exit ${code})`);
}

/**
 * skopeo copy a locally built image to the registry (sha tag + latest).
 * @returns {Promise<string>} the pushed manifest digest
 */
export async function pushImage(builder, reg, localRef, remoteRepo, sha) {
  if (!(await commandExists('skopeo'))) {
    throw new Error('mieweb images: skopeo not found on PATH (`brew install skopeo`).');
  }
  for (const tag of [sha, 'latest']) {
    const dest = `docker://${remoteRepo}:${tag}`;
    const code = await run('skopeo', [
      'copy',
      ...skopeoAuthFlags(reg, 'dest'),
      builder.srcTransport(localRef),
      dest,
    ]);
    if (code !== 0) throw new Error(`mieweb images: skopeo copy to ${dest} failed (exit ${code})`);
  }
  return inspectDigest(reg, `${remoteRepo}:${sha}`);
}

/** skopeo inspect a remote ref and return its digest. */
async function inspectDigest(reg, ref) {
  const { code, stdout, stderr } = await capture('skopeo', [
    'inspect',
    ...skopeoAuthFlags(reg, 'src'),
    `docker://${ref}`,
  ]);
  if (code !== 0) throw new Error(`mieweb images: skopeo inspect docker://${ref} failed: ${stderr.trim()}`);
  return JSON.parse(stdout).Digest;
}

/* -------------------------------------------------------------- commands */

/**
 * Entry point for `mieweb images <build|push|inspect|status> [...]`.
 * @param {string[]} args after "images"
 * @param {import('./config.mjs').MiewebConfig} config
 * @returns {Promise<number>}
 */
export async function runImagesCommand(args, config) {
  const sub = args[0];
  const containers = buildableContainers(config);
  if (containers.length === 0) {
    console.error('mieweb images: no `containers` entries with a local Dockerfile in wrangler.jsonc.');
    return 1;
  }

  const sha = await gitShortSha(config.root);

  if (sub === 'build' || sub === 'push') {
    const builder = await detectBuilder();
    /** @type {Record<string, any>} */
    const lock = readLock(config.root);

    for (const c of containers) {
      const localRef = `mieweb/${String(c.class_name).toLowerCase()}:${sha}`;
      console.log(`[mieweb] building ${c.class_name} → ${localRef} (${builder.name})`);
      await buildImage(builder, c, config.root, localRef);

      if (sub === 'push') {
        const reg = registryFor(config);
        const repo = repoRef(reg, c, config);
        console.log(`[mieweb] pushing ${localRef} → ${repo}:{${sha},latest} (skopeo)`);
        const digest = await pushImage(builder, reg, localRef, repo, sha);
        lock[c.class_name] = { ...(lock[c.class_name] ?? {}), [config.target]: { repo, tag: sha, digest } };
        console.log(`[mieweb] pinned ${c.class_name}@${digest}`);
      }
    }
    if (sub === 'push') writeLock(config.root, lock);
    return 0;
  }

  if (sub === 'inspect') {
    const reg = registryFor(config);
    const nameArg = args[1];
    const targets = nameArg
      ? containers.filter(
          (c) => c.class_name === nameArg || config.containerBindings?.[nameArg]?.class_name === c.class_name,
        )
      : containers;
    if (targets.length === 0) {
      console.error(`mieweb images: no container matches "${nameArg}".`);
      return 1;
    }
    for (const c of targets) {
      const code = await run('skopeo', [
        'inspect',
        ...skopeoAuthFlags(reg, 'src'),
        `docker://${repoRef(reg, c, config)}:latest`,
      ]);
      if (code !== 0) return code;
    }
    return 0;
  }

  if (sub === 'status') {
    const lock = readLock(config.root);
    if (Object.keys(lock).length === 0) {
      console.log('mieweb images: no lockfile yet (.mieweb/images.lock.json) — run `mieweb images push`.');
      return 0;
    }
    const reg = registryFor(config);
    for (const [className, perTarget] of Object.entries(lock)) {
      const pinned = perTarget?.[config.target];
      if (!pinned) {
        console.log(`${className}: no pin for target "${config.target}"`);
        continue;
      }
      try {
        const live = await inspectDigest(reg, `${pinned.repo}:latest`);
        const match = live === pinned.digest ? 'in sync' : `DRIFT (latest=${live})`;
        console.log(`${className}: pinned ${pinned.tag} ${pinned.digest} — ${match}`);
      } catch (err) {
        console.log(`${className}: pinned ${pinned.tag} ${pinned.digest} — inspect failed: ${/** @type {Error} */ (err).message}`);
      }
    }
    return 0;
  }

  console.error('Usage: mieweb images <build|push|inspect [BINDING|Class]|status>');
  return 1;
}

/**
 * Entry point for `mieweb registry <login|logout>`.
 * @param {string[]} args after "registry"
 * @param {import('./config.mjs').MiewebConfig} config
 * @returns {Promise<number>}
 */
export async function runRegistryCommand(args, config) {
  const sub = args[0];
  if (sub !== 'login' && sub !== 'logout') {
    console.error('Usage: mieweb registry <login|logout>');
    return 1;
  }
  if (!(await commandExists('skopeo'))) {
    console.error('mieweb registry: skopeo not found on PATH (`brew install skopeo`).');
    return 1;
  }
  const reg = registryFor(config);
  const flags = [];
  if (reg.authFile) flags.push('--authfile', expandHome(reg.authFile));
  if (reg.insecureSkipTlsVerify) flags.push('--tls-verify=false');
  if (sub === 'login' && reg.username) flags.push('--username', reg.username);
  // Interactive: skopeo prompts for the password itself — never passed via argv.
  return run('skopeo', [sub, ...flags, reg.url]);
}
