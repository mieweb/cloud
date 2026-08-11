/**
 * @mieweb/cloud-agent-cli — Message-first CLI dispatcher for @mieweb/cloud-agent.
 *
 * Agent identity is determined by basename(argv[0]) (busybox/git multicall pattern).
 * Agent-specific packages wrap this with their config.
 *
 * Configuration not passed explicitly is read from the agent's environment
 * namespace (`assistant` reads `ASSISTANT_URL`), falling back to `AGENT_URL`.
 *
 * @example
 * ```ts
 * // packages/cli/bin/assistant.js
 * import { run } from '@mieweb/cloud-agent-cli';
 *
 * run({
 *   agent: 'assistant',
 *   version: '0.1.0',
 * });
 * ```
 */

export { run } from "./run.js";
export { parseArgs } from "./parse.js";
export { envPrefix, readEnv } from "./env.js";
export { streamCall, fireAndForget, getStatus } from "./client.js";
export type {
  CliConfig,
  ParsedCommand,
  CliOptions,
  StreamEvent,
} from "./types.js";
