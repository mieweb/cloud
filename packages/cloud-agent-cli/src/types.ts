/**
 * @mieweb/cloud-agent-cli type definitions
 */

/**
 * CLI configuration passed to run().
 */
export interface CliConfig {
  /** Agent name (used for routing and display) */
  agent: string;
  /** Base URL for the agent server (default: http://127.0.0.1:8787) */
  baseUrl?: string;
  /** Privacy profile to send with requests */
  profile?: unknown;
  /** Version string for --version */
  version?: string;
}

/**
 * Parsed command from CLI arguments.
 */
export type ParsedCommand =
  | { type: "call"; message: string; sessionId?: string }
  | { type: "put"; message: string; sessionId?: string }
  | { type: "help" }
  | { type: "version" }
  | { type: "debug"; message: string; sessionId?: string }
  | { type: "report"; args: string[] }
  | { type: "config"; args: string[] };

/**
 * Options extracted from CLI flags.
 */
export interface CliOptions {
  sessionId?: string;
  debug?: boolean;
  cwd?: string;
}

/**
 * Streaming response event from the agent.
 */
export type StreamEvent =
  | { type: "start" }
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; input: unknown }
  | { type: "tool-result"; toolName: string; output: unknown }
  | { type: "finish"; finishReason: string }
  | { type: "error"; message: string }
  | { type: "suspended"; reason: string; message?: string };
