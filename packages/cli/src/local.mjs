import { resolve } from 'node:path';

/**
 * Dispatch a command on the `local` target to the @mieweb/cloud-local adapters.
 *
 * Supported today:
 *   * `mieweb d1 migrations apply [db]`  → apply ./migrations to local SQLite
 *   * `mieweb dev`                       → start the Node host harness
 *
 * Anything else returns a clear "not implemented for local" message rather
 * than silently doing the wrong thing.
 *
 * @param {string[]} args command + args (target flag already stripped)
 * @param {import('./config.mjs').MiewebConfig} config
 * @returns {Promise<number>} exit code
 */
export async function runLocal(args, config) {
  const [cmd, ...rest] = args;

  if (cmd === 'd1' && rest[0] === 'migrations' && rest[1] === 'apply') {
    return d1MigrationsApply(config);
  }

  if (cmd === 'dev') {
    return dev(config);
  }

  console.error(
    `mieweb: command "${args.join(' ')}" is not implemented for target "local" yet.\n` +
      'Supported local commands: `d1 migrations apply`, `dev`.',
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
    console.error('mieweb: target "local" has no sqlite DB binding configured.');
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
