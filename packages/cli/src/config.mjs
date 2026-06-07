import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

/**
 * @typedef {'cloudflare'|'local'|'mieweb'|'aws'|'gcp'} CloudTarget
 *
 * @typedef {Object} MiewebConfig
 * @property {string} configPath  absolute path to mieweb.jsonc (or wrangler.jsonc if no sidecar)
 * @property {string} root        absolute repo root (dir holding the config)
 * @property {CloudTarget} target resolved active target
 * @property {string} wranglerPath absolute path to wrangler.jsonc
 * @property {Record<string, unknown>} wrangler parsed wrangler.jsonc
 * @property {Record<string, unknown>} raw      parsed mieweb.jsonc (or {} )
 * @property {Record<string, any>} targetConfig adapter config for the active target
 */

/**
 * Locate and load the mieweb/wrangler configuration.
 *
 * Resolution order for the active target:
 *   1. explicit `--target <t>` (passed in `overrideTarget`)
 *   2. `MIEWEB_TARGET` env var
 *   3. `target` field in mieweb.jsonc
 *   4. `'cloudflare'` (the reference default)
 *
 * @param {{ cwd?: string, overrideTarget?: string|null }} [opts]
 * @returns {MiewebConfig}
 */
export function loadConfig(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const miewebPath = findUp('mieweb.jsonc', cwd);
  const root = miewebPath ? dirname(miewebPath) : (findUp('wrangler.jsonc', cwd) ? dirname(/** @type {string} */ (findUp('wrangler.jsonc', cwd))) : cwd);

  /** @type {Record<string, any>} */
  let raw = {};
  if (miewebPath && existsSync(miewebPath)) {
    raw = /** @type {Record<string, any>} */ (parseJsonc(readFileSync(miewebPath, 'utf8')));
  }

  const wranglerRel = typeof raw.wrangler === 'string' ? raw.wrangler : './wrangler.jsonc';
  const wranglerPath = isAbsolute(wranglerRel) ? wranglerRel : resolve(root, wranglerRel);
  /** @type {Record<string, unknown>} */
  let wrangler = {};
  if (existsSync(wranglerPath)) {
    wrangler = /** @type {Record<string, unknown>} */ (parseJsonc(readFileSync(wranglerPath, 'utf8')));
  }

  const target = /** @type {CloudTarget} */ (
    opts.overrideTarget || process.env.MIEWEB_TARGET || raw.target || 'cloudflare'
  );

  const targetConfig = (raw.targets && raw.targets[target]) || {};

  return {
    configPath: miewebPath ?? wranglerPath,
    root,
    target,
    wranglerPath,
    wrangler,
    raw,
    targetConfig,
  };
}

/**
 * Walk up from `start` looking for `name`.
 * @param {string} name
 * @param {string} start
 * @returns {string|null}
 */
function findUp(name, start) {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
