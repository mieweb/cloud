import { spawn } from 'node:child_process';

/**
 * Delegate a command verbatim to the real `wrangler` binary.
 *
 * Used on the `cloudflare` target so that `mieweb dev`, `mieweb deploy`,
 * `mieweb tail`, `mieweb d1 migrations apply ...`, etc. behave exactly like
 * their wrangler equivalents — Cloudflare stays first-class with zero
 * translation. We resolve wrangler through the package manager so the repo's
 * pinned version is used.
 *
 * @param {string[]} args arguments to forward to wrangler
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<number>} wrangler's exit code
 */
export function delegateToWrangler(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();

  // Prefer an explicit escape hatch, then a repo-local wrangler, then PATH.
  const real = process.env.MIEWEB_REAL_WRANGLER;
  const command = real || 'wrangler';
  // When falling back to the bare name we go through the package runner so the
  // workspace-pinned wrangler resolves even if it isn't on PATH globally.
  const useRunner = !real;

  const finalCmd = useRunner ? 'pnpm' : command;
  const finalArgs = useRunner ? ['exec', 'wrangler', ...args] : args;

  return new Promise((resolvePromise, reject) => {
    const child = spawn(finalCmd, finalArgs, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise(code ?? 0));
  });
}
