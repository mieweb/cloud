/**
 * CLI argument parsing.
 * Message-first: all args are joined as a message unless the first arg is a flag.
 */

import type { ParsedCommand, CliOptions } from "./types.js";

/**
 * Parse CLI arguments into a command and options.
 */
export function parseArgs(args: string[]): {
  command: ParsedCommand;
  options: CliOptions;
} {
  const options: CliOptions = {
    sessionId: process.env.JERRY_SESSION,
    cwd: process.cwd(),
  };

  if (args.length === 0) {
    return { command: { type: "help" }, options };
  }

  const first = args[0];

  // Check for flags
  if (first.startsWith("-")) {
    return parseFlag(first, args.slice(1), options);
  }

  // Default: --call with message
  const message = args.join(" ");
  return {
    command: { type: "call", message, sessionId: options.sessionId },
    options,
  };
}

/**
 * Parse a flag-based command.
 */
function parseFlag(
  flag: string,
  rest: string[],
  options: CliOptions
): { command: ParsedCommand; options: CliOptions } {
  switch (flag) {
    case "-h":
    case "--help":
      return { command: { type: "help" }, options };

    case "-v":
    case "--version":
      return { command: { type: "version" }, options };

    case "-txt":
    case "--put":
      if (rest.length === 0) {
        return { command: { type: "help" }, options };
      }
      return {
        command: {
          type: "put",
          message: rest.join(" "),
          sessionId: options.sessionId,
        },
        options,
      };

    case "--call":
      if (rest.length === 0) {
        return { command: { type: "help" }, options };
      }
      return {
        command: {
          type: "call",
          message: rest.join(" "),
          sessionId: options.sessionId,
        },
        options,
      };

    case "-d":
    case "--debug":
      if (rest.length === 0) {
        return { command: { type: "help" }, options };
      }
      return {
        command: {
          type: "debug",
          message: rest.join(" "),
          sessionId: options.sessionId,
        },
        options: { ...options, debug: true },
      };

    case "--report":
      return {
        command: { type: "report", args: rest },
        options,
      };

    case "--config":
      return {
        command: { type: "config", args: rest },
        options,
      };

    case "-s":
    case "--session":
      if (rest.length === 0) {
        return { command: { type: "help" }, options };
      }
      options.sessionId = rest[0];
      if (rest.length === 1) {
        return { command: { type: "help" }, options };
      }
      // Parse remaining args as message
      const message = rest.slice(1).join(" ");
      return {
        command: { type: "call", message, sessionId: options.sessionId },
        options,
      };

    default:
      // Unknown flag, treat as message
      return {
        command: {
          type: "call",
          message: [flag, ...rest].join(" "),
          sessionId: options.sessionId,
        },
        options,
      };
  }
}
