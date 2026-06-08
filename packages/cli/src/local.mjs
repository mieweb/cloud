import { resolve } from 'node:path';

/**
 * Dispatch a command on a Node "host" target (`local`, `mieweb`, …) through the
 * shared Node host harness in @mieweb/cloud-local.
 *
 *   * `local`  → @mieweb/cloud-local drivers (SQLite / fs / memory / in-proc).
 *   * `mieweb` → @mieweb/cloud-os drivers (libSQL / S3 / Valkey). Importing that
 *     package registers its drivers into the shared registry; the very same
 *     host harness then builds the env and runs the unchanged worker.
 *
 * Supported commands:
 *   * `mieweb [--target <t>] d1 migrations apply [db]`  (local / sqlite only)
 *   * `mieweb [--target <t>] dev`                       → start the host harness
 *
 * Anything else returns a clear "not implemented" message rather than silently
 * doing the wrong thing.
 *
 * @param {string[]} args command + args (target flag already stripped)
 * @param {import('./config.mjs').MiewebConfig} config
 * @returns {Promise<number>} exit code
 */
export async function runHostTarget(args, config) {
  // Non-local host targets ship their drivers in a separate package; importing
  // it is enough to register them into @mieweb/cloud-local's shared registry.
  if (config.target === 'mieweb') {
    await import('@mieweb/cloud-os');
  }

  const [cmd, ...rest] = args;

  if (cmd === 'd1' && rest[0] === 'migrations' && rest[1] === 'apply') {
    return d1MigrationsApply(config);
  }

  if (cmd === 'dev') {
    return dev(config);
  }

  console.error(
    `mieweb: command "${args.join(' ')}" is not implemented for target "${config.target}" yet.\n` +
      'Supported commands: `d1 migrations apply` (local), `dev`.',
  );
  return 1;
}

/**
 * Apply migrations to the local SQLite DB configured for the DB binding.
 * @param {import('./config.mjs').MiewebConfig} config
 */
async function d1MigrationsApply(config) {
  const dbCfg = config.targetConfig?.bindings?.DB;
  if (!dbCfg || dbCfg.driver !== 'sqlite') {
    console.error(
      `mieweb: target "${config.target}" has no sqlite DB binding to migrate. ` +
        'Migrations are only wired for the local/sqlite driver today; other ' +
        'targets manage schema with their own tooling (e.g. libSQL).',
    );
    return 1;
  }
  const migrationsDir = resolve(
    config.root,
    /** @type {string} */ (config.wrangler?.d1_databases?.[0]?.migrations_dir) || 'migrations',
  );
  const dbPath = resolve(config.root, dbCfg.path);

  const { applyMigrations } = await import('@mieweb/cloud-local/migrate');
  const { applied, skipped } = await applyMigrations({ dbPath, migrationsDir });

  console.log(
    `[mieweb] migrations applied to ${dbPath}\n` +
      `  applied: ${applied.length}${applied.length ? ` (${applied[applied.length - 1]})` : ''}\n` +
      `  already up to date: ${skipped.length}`,
  );
  return 0;
}

/**
 * Start the local Node host harness.
 * @param {import('./config.mjs').MiewebConfig} config
 */
async function dev(config) {
  const { startLocalHost } = await import('@mieweb/cloud-local/host');
  const handle = await startLocalHost({ config });
  // Keep the process alive until interrupted.
  return new Promise((resolvePromise) => {
    const shutdown = () => {
      handle.stop();
      resolvePromise(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
