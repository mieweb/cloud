/**
 * @mieweb/cloud-agent-cli — Message-first CLI dispatcher for @mieweb/cloud-agent.
 *
 * Agent identity is determined by basename(argv[0]) (busybox/git multicall pattern).
 * Agent-specific packages wrap this with their config.
 *
 * @example
 * ```ts
 * // packages/cli/bin/jerry.js
 * import { run } from '@mieweb/cloud-agent-cli';
 *
 * run({
 *   agent: 'jerry',
 *   baseUrl: process.env.JERRY_URL ?? 'http://127.0.0.1:8787',
 *   version: '0.1.0',
 * });
 * ```
 */

export { run } from "./run.js";
export { parseArgs } from "./parse.js";
export { streamCall, fireAndForget, getStatus } from "./client.js";
export type {
  CliConfig,
  ParsedCommand,
  CliOptions,
  StreamEvent,
} from "./types.js";
