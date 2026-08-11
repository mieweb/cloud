/**
 * Tests for agent-scoped environment variable resolution.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { envPrefix, readEnv } from "./env.js";

describe("envPrefix", () => {
  it("upper-cases a simple agent name", () => {
    assert.strictEqual(envPrefix("assistant"), "ASSISTANT");
  });

  it("normalizes separators to underscores", () => {
    assert.strictEqual(envPrefix("my-agent"), "MY_AGENT");
    assert.strictEqual(envPrefix("my.agent v2"), "MY_AGENT_V2");
  });

  it("falls back to AGENT for empty or unusable names", () => {
    assert.strictEqual(envPrefix(undefined), "AGENT");
    assert.strictEqual(envPrefix(""), "AGENT");
    assert.strictEqual(envPrefix("---"), "AGENT");
  });
});

describe("readEnv", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.AGENT_URL;
    delete process.env.ASSISTANT_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when nothing is set", () => {
    assert.strictEqual(readEnv("assistant", "URL"), undefined);
  });

  it("prefers the agent-scoped variable over the shared one", () => {
    process.env.AGENT_URL = "http://shared";
    process.env.ASSISTANT_URL = "http://scoped";
    assert.strictEqual(readEnv("assistant", "URL"), "http://scoped");
  });

  it("falls back to the shared variable", () => {
    process.env.AGENT_URL = "http://shared";
    assert.strictEqual(readEnv("assistant", "URL"), "http://shared");
  });

  it("reads the shared variable when no agent name is given", () => {
    process.env.AGENT_URL = "http://shared";
    assert.strictEqual(readEnv(undefined, "URL"), "http://shared");
  });
});
