import { runWrangler } from '@mieweb/deploy-wrangler';

/**
 * Delegate a command verbatim to the real `wrangler` binary.
 *
 * Used on the `cloudflare` target for commands that don't go through the
 * deploy provider (`d1 migrations apply`, `containers push`, …) so they behave
 * exactly like their wrangler equivalents. Launches wrangler the same way the
 * reference provider does (MIEWEB_REAL_WRANGLER, else the project's wrangler
 * via the active package manager).
 *
 * Never throws: a missing wrangler (or a failed spawn) is reported on stderr
 * and returned as exit code 1.
 *
 * @param {string[]} args arguments to forward to wrangler
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<number>} wrangler's exit code (1 if it couldn't run or was killed)
 */
export async function delegateToWrangler(args, opts = {}) {
  try {
    const { code } = await runWrangler(args, { cwd: opts.cwd ?? process.cwd() });
    return code ?? 1;
  } catch (err) {
    console.error(`mieweb: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
