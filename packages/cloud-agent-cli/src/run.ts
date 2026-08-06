/**
 * CLI run function for message-first agent interaction.
 */

import type { CliConfig, CliOptions } from "./types.js";
import { parseArgs } from "./parse.js";
import { streamCall, fireAndForget } from "./client.js";
import { envPrefix, readEnv } from "./env.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/**
 * Run the CLI with the given config.
 * Agent-specific wrappers call this with their config.
 */
export async function run(config: CliConfig): Promise<void> {
  const baseUrl =
    config.baseUrl ?? readEnv(config.agent, "URL") ?? DEFAULT_BASE_URL;
  const { command, options } = parseArgs(process.argv.slice(2), config.agent);

  switch (command.type) {
    case "help":
      printHelp(config.agent);
      break;

    case "version":
      console.log(`${config.agent} ${config.version ?? "0.0.0"}`);
      break;

    case "call":
      await handleCall(baseUrl, config, command.message, options);
      break;

    case "put":
      await handlePut(baseUrl, config, command.message, options);
      break;

    case "debug":
      options.debug = true;
      await handleCall(baseUrl, config, command.message, options);
      break;

    case "report":
      console.log("Report mode not yet implemented");
      break;

    case "config":
      console.log("Config:", JSON.stringify(config, null, 2));
      break;
  }
}

/**
 * Handle --call (default): send message, stream reply.
 */
async function handleCall(
  baseUrl: string,
  config: CliConfig,
  message: string,
  options: CliOptions
): Promise<void> {
  const sessionId = options.sessionId ?? generateSessionId();
  const toolsUsed: string[] = [];
  let finishReason: string | undefined;

  const noteTool = (name: string | undefined) => {
    if (name && !toolsUsed.includes(name)) toolsUsed.push(name);
  };

  if (options.debug) {
    console.error(`[debug] agent=${config.agent} session=${sessionId}`);
    console.error(`[debug] baseUrl=${baseUrl}`);
    console.error(`[debug] cwd=${options.cwd ?? process.cwd()}`);
  }

  try {
    for await (const event of streamCall(baseUrl, sessionId, message, {
      profile: config.profile,
      cwd: options.cwd ?? process.cwd(),
    })) {
      if (event.type === "text") {
        process.stdout.write(event.text);
      } else if (event.type === "tool-call") {
        noteTool(event.toolName);
        if (options.debug) {
          console.error(`[tool] ${event.toolName}(${JSON.stringify(event.input)})`);
        }
      } else if (event.type === "tool-result" && options.debug) {
        console.error(`[tool-result] ${event.toolName}: ${JSON.stringify(event.output)}`);
      } else if (event.type === "error") {
        console.error(`\nError: ${event.message}`);
        process.exitCode = 1;
      } else if (event.type === "suspended") {
        event.toolsUsed?.forEach(noteTool);
        console.log(`\n[${event.reason}] ${event.message ?? ""}`);
        console.log(`Session: ${sessionId}`);
      } else if (event.type === "finish") {
        finishReason = event.finishReason;
        event.toolsUsed?.forEach(noteTool);
        if (options.debug) {
          console.error(`\n[finish] reason=${event.finishReason}`);
        }
      }
    }
    console.log(); // Final newline after the reply
    if (finishReason === "length") {
      console.error(
        "[truncated] model hit the output token limit — ask to continue"
      );
    }
    if (toolsUsed.length > 0) {
      console.log(`tools: ${toolsUsed.join(" · ")}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

/**
 * Handle -txt/--put: enqueue message, return immediately.
 */
async function handlePut(
  baseUrl: string,
  config: CliConfig,
  message: string,
  options: CliOptions
): Promise<void> {
  const sessionId = options.sessionId ?? generateSessionId();

  try {
    const result = await fireAndForget(baseUrl, sessionId, message, {
      profile: config.profile,
      cwd: options.cwd ?? process.cwd(),
    });
    console.log(`Queued: session=${sessionId} eventId=${result.eventId}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

/**
 * Generate a session ID (for new conversations).
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Print help message.
 */
function printHelp(agent: string): void {
  const prefix = envPrefix(agent);
  const urlVar = `${prefix}_URL`;
  const sessionVar = `${prefix}_SESSION`;
  const pad = (name: string) =>
    name.padEnd(Math.max(urlVar.length, sessionVar.length) + 3);
  console.log(`
${agent} — message-first CLI

Usage:
  ${agent} <message>              Send message and stream reply (default --call)
  ${agent} -txt <message>         Enqueue message, return immediately
  ${agent} --put <message>        Same as -txt
  ${agent} --help                 Show this help
  ${agent} --version              Show version
  ${agent} --debug <message>      Send with debug output
  ${agent} --config               Show current config

Arguments are joined with spaces, so quotes are only needed to preserve
multiple spaces or escape shell metacharacters.

Examples:
  ${agent} summarize my last 2 hours
  ${agent} I just made this PR
  ${agent} -txt quick note for the day

Environment (falls back to AGENT_URL / AGENT_SESSION):
  ${pad(urlVar)}Override base URL (default: ${DEFAULT_BASE_URL})
  ${pad(sessionVar)}Override session ID
`.trim());
}
