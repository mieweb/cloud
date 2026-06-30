/**
 * Tests for CLI argument parsing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { parseArgs } from "./parse.js";

describe("parseArgs", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.JERRY_SESSION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("message-first behavior", () => {
    it("treats non-flag args as a message for --call", () => {
      const { command } = parseArgs(["hello", "world"]);
      assert.strictEqual(command.type, "call");
      if (command.type === "call") {
        assert.strictEqual(command.message, "hello world");
      }
    });

    it("joins all args with spaces", () => {
      const { command } = parseArgs(["summarize", "my", "last", "2", "hours"]);
      assert.strictEqual(command.type, "call");
      if (command.type === "call") {
        assert.strictEqual(command.message, "summarize my last 2 hours");
      }
    });

    it("returns help when no args", () => {
      const { command } = parseArgs([]);
      assert.strictEqual(command.type, "help");
    });
  });

  describe("flags", () => {
    it("parses --help", () => {
      const { command } = parseArgs(["--help"]);
      assert.strictEqual(command.type, "help");
    });

    it("parses -h", () => {
      const { command } = parseArgs(["-h"]);
      assert.strictEqual(command.type, "help");
    });

    it("parses --version", () => {
      const { command } = parseArgs(["--version"]);
      assert.strictEqual(command.type, "version");
    });

    it("parses -v", () => {
      const { command } = parseArgs(["-v"]);
      assert.strictEqual(command.type, "version");
    });

    it("parses -txt with message", () => {
      const { command } = parseArgs(["-txt", "quick", "note"]);
      assert.strictEqual(command.type, "put");
      if (command.type === "put") {
        assert.strictEqual(command.message, "quick note");
      }
    });

    it("parses --put with message", () => {
      const { command } = parseArgs(["--put", "enqueue", "this"]);
      assert.strictEqual(command.type, "put");
      if (command.type === "put") {
        assert.strictEqual(command.message, "enqueue this");
      }
    });

    it("parses --debug with message", () => {
      const { command, options } = parseArgs(["--debug", "test", "message"]);
      assert.strictEqual(command.type, "debug");
      assert.strictEqual(options.debug, true);
      if (command.type === "debug") {
        assert.strictEqual(command.message, "test message");
      }
    });

    it("parses --config", () => {
      const { command } = parseArgs(["--config"]);
      assert.strictEqual(command.type, "config");
    });

    it("parses --report", () => {
      const { command } = parseArgs(["--report", "daily"]);
      assert.strictEqual(command.type, "report");
      if (command.type === "report") {
        assert.deepStrictEqual(command.args, ["daily"]);
      }
    });
  });

  describe("session handling", () => {
    it("uses JERRY_SESSION from env", () => {
      process.env.JERRY_SESSION = "test-session-123";
      const { command, options } = parseArgs(["hello"]);
      assert.strictEqual(options.sessionId, "test-session-123");
    });

    it("parses --session flag", () => {
      const { command, options } = parseArgs(["--session", "my-session", "hello", "world"]);
      assert.strictEqual(options.sessionId, "my-session");
      assert.strictEqual(command.type, "call");
      if (command.type === "call") {
        assert.strictEqual(command.message, "hello world");
      }
    });
  });

  describe("edge cases", () => {
    it("treats unknown flags as message content", () => {
      const { command } = parseArgs(["--unknown", "flag"]);
      assert.strictEqual(command.type, "call");
      if (command.type === "call") {
        assert.strictEqual(command.message, "--unknown flag");
      }
    });

    it("returns help for -txt with no message", () => {
      const { command } = parseArgs(["-txt"]);
      assert.strictEqual(command.type, "help");
    });
  });
});
