/**
 * Tests for cloud-agent storage operations.
 * Uses a mock CloudDatabase for testing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

/**
 * Mock CloudDatabase implementation for testing.
 * Stores data in memory.
 */
class MockDatabase {
  private tables: Map<string, unknown[]> = new Map();
  private execStatements: string[] = [];

  async exec(sql: string): Promise<void> {
    this.execStatements.push(sql);
    const createTableMatches = sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g);
    for (const match of createTableMatches) {
      if (!this.tables.has(match[1])) {
        this.tables.set(match[1], []);
      }
    }
  }

  prepare(sql: string) {
    const db = this;
    let boundValues: unknown[] = [];

    return {
      bind(...values: unknown[]) {
        boundValues = values;
        return this;
      },
      async run() {
        const insertMatch = sql.match(/INSERT INTO (\w+)/i);
        if (insertMatch) {
          const table = insertMatch[1];
          const rows = db.tables.get(table) ?? [];
          rows.push({ values: boundValues });
          db.tables.set(table, rows);
          return { meta: { last_row_id: rows.length } };
        }
        return {};
      },
      async first<T>(): Promise<T | null> {
        const selectMatch = sql.match(/SELECT .* FROM (\w+) WHERE id = \?/i);
        if (selectMatch) {
          const table = selectMatch[1];
          const rows = db.tables.get(table) ?? [];
          const row = rows.find((r: any) => r.values?.[0] === boundValues[0]);
          if (row) {
            return row as T;
          }
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const selectMatch = sql.match(/SELECT .* FROM (\w+)/i);
        if (selectMatch) {
          const table = selectMatch[1];
          const rows = db.tables.get(table) ?? [];
          return { results: rows as T[] };
        }
        return { results: [] };
      },
    };
  }

  getExecStatements() {
    return this.execStatements;
  }

  getTable(name: string) {
    return this.tables.get(name);
  }
}

import {
  initSchema,
  getOrCreateSession,
  updateSessionStatus,
  insertEvent,
  insertMessage,
  getSessionMessages,
  insertActivityEvent,
  insertSummary,
} from "./storage.js";

describe("storage", () => {
  let db: MockDatabase;

  beforeEach(() => {
    db = new MockDatabase();
  });

  describe("initSchema", () => {
    it("creates all required tables", async () => {
      await initSchema(db as any);
      const statements = db.getExecStatements();
      assert.ok(statements.length > 0);
      assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS sessions"));
      assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS events"));
      assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS messages"));
      assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS activity_events"));
      assert.ok(statements[0].includes("CREATE TABLE IF NOT EXISTS summaries"));
    });
  });

  describe("getOrCreateSession", () => {
    it("creates a new session when none exists", async () => {
      await initSchema(db as any);
      const session = await getOrCreateSession(db as any, "test-session-1", "user-1");
      assert.strictEqual(session.id, "test-session-1");
      assert.strictEqual(session.userId, "user-1");
      assert.strictEqual(session.status, "idle");
      assert.ok(session.conversationId);
    });
  });

  describe("insertEvent", () => {
    it("inserts a lifecycle event", async () => {
      await initSchema(db as any);
      const id = await insertEvent(db as any, "session-1", "user_message", { text: "hello" });
      assert.ok(id);
      const events = db.getTable("events");
      assert.ok(events && events.length > 0);
    });
  });

  describe("insertMessage", () => {
    it("inserts a conversation message", async () => {
      await initSchema(db as any);
      const id = await insertMessage(db as any, "session-1", "user", "Hello world");
      assert.ok(id);
      const messages = db.getTable("messages");
      assert.ok(messages && messages.length > 0);
    });
  });

  describe("insertActivityEvent", () => {
    it("inserts an activity event from collector", async () => {
      await initSchema(db as any);
      const id = await insertActivityEvent(
        db as any,
        "aw",
        { bucket: "aw-watcher-window" },
        "2024-01-01T12:00:00Z"
      );
      assert.ok(id);
      const events = db.getTable("activity_events");
      assert.ok(events && events.length > 0);
    });
  });

  describe("insertSummary", () => {
    it("inserts an activity summary", async () => {
      await initSchema(db as any);
      const id = await insertSummary(
        db as any,
        "session-1",
        "2024-01-01T10:00:00Z",
        "2024-01-01T12:00:00Z",
        { totalMinutes: 120 }
      );
      assert.ok(id);
      const summaries = db.getTable("summaries");
      assert.ok(summaries && summaries.length > 0);
    });
  });
});
