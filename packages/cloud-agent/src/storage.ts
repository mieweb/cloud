/**
 * Storage operations for sessions, events, messages, and summaries.
 * All operations use CloudDatabase (D1-compatible).
 */

import type { CloudDatabase } from "@mieweb/cloud-types";
import type {
  Session,
  SessionStatus,
  LifecycleEvent,
  ConversationMessage,
  ContinuationState,
  EventType,
  MessageRole,
} from "./types.js";

function generateId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Schema statements, one per entry.
 *
 * D1's exec() splits on newlines and rejects statements that span lines, so the
 * schema is applied as individual prepared statements instead. prepare()/run()
 * is the one path every backend implements.
 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      conversation_id TEXT,
      continuation TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      payload TEXT,
      occurred_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      range_start TEXT NOT NULL,
      range_end TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL
    )`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_events_occurred ON activity_events(occurred_at)`,
];

/**
 * Initialize the schema. Idempotent - safe to call on every request.
 */
export async function initSchema(db: CloudDatabase): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.prepare(statement).run();
  }
}

/**
 * Get or create a session by ID.
 */
export async function getOrCreateSession(
  db: CloudDatabase,
  sessionId: string,
  userId?: string
): Promise<Session> {
  const existing = await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{
      id: string;
      user_id: string | null;
      status: string;
      conversation_id: string | null;
      continuation: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (existing) {
    return {
      id: existing.id,
      userId: existing.user_id ?? undefined,
      status: existing.status as SessionStatus,
      conversationId: existing.conversation_id ?? undefined,
      continuation: existing.continuation
        ? JSON.parse(existing.continuation)
        : undefined,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
    };
  }

  const now = nowISO();
  const conversationId = generateId();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, status, conversation_id, created_at, updated_at)
       VALUES (?, ?, 'idle', ?, ?, ?)`
    )
    .bind(sessionId, userId ?? null, conversationId, now, now)
    .run();

  return {
    id: sessionId,
    userId,
    status: "idle",
    conversationId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update session status and optionally continuation state.
 */
export async function updateSessionStatus(
  db: CloudDatabase,
  sessionId: string,
  status: SessionStatus,
  continuation?: ContinuationState | null
): Promise<void> {
  const now = nowISO();
  await db
    .prepare(
      `UPDATE sessions 
       SET status = ?, continuation = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      status,
      continuation ? JSON.stringify(continuation) : null,
      now,
      sessionId
    )
    .run();
}

/**
 * Insert a lifecycle event.
 */
export async function insertEvent(
  db: CloudDatabase,
  sessionId: string,
  type: EventType,
  payload?: unknown
): Promise<string> {
  const id = generateId();
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO events (id, session_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, sessionId, type, payload === undefined ? null : JSON.stringify(payload), now)
    .run();
  return id;
}

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  payload: string | null;
  created_at: string;
}

/**
 * Get recent events for a session.
 */
export async function getSessionEvents(
  db: CloudDatabase,
  sessionId: string,
  limit = 100
): Promise<LifecycleEvent[]> {
  const rows = await db
    .prepare(
      `SELECT id, session_id, type, payload, created_at
       FROM events
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(sessionId, limit)
    .all<EventRow>();

  return (rows.results ?? []).map((row: EventRow) => ({
    id: row.id,
    sessionId: row.session_id,
    type: row.type as EventType,
    payload: row.payload ? JSON.parse(row.payload) : null,
    createdAt: row.created_at,
  }));
}

/**
 * Insert a conversation message.
 */
export async function insertMessage(
  db: CloudDatabase,
  sessionId: string,
  role: MessageRole,
  content: unknown
): Promise<string> {
  const id = generateId();
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, sessionId, role, JSON.stringify(content), now)
    .run();
  return id;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  created_at: string;
}

/**
 * Get conversation messages for a session.
 */
export async function getSessionMessages(
  db: CloudDatabase,
  sessionId: string
): Promise<ConversationMessage[]> {
  const rows = await db
    .prepare(
      `SELECT id, session_id, role, content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`
    )
    .bind(sessionId)
    .all<MessageRow>();

  return (rows.results ?? []).map((row: MessageRow) => ({
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content ? JSON.parse(row.content) : null,
    createdAt: row.created_at,
  }));
}

/**
 * Insert an activity event from collector.
 */
export async function insertActivityEvent(
  db: CloudDatabase,
  source: string,
  payload: unknown,
  occurredAt: string
): Promise<string> {
  const id = generateId();
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO activity_events (id, source, payload, occurred_at, ingested_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(id, source, JSON.stringify(payload), occurredAt, now)
    .run();
  return id;
}

interface ActivityEventRow {
  id: string;
  source: string;
  payload: string | null;
  occurred_at: string;
}

/**
 * Get activity events in a time range.
 */
export async function getActivityEvents(
  db: CloudDatabase,
  start: string,
  end: string,
  source?: string
): Promise<Array<{ id: string; source: string; payload: unknown; occurredAt: string }>> {
  const query = source
    ? `SELECT id, source, payload, occurred_at
       FROM activity_events
       WHERE occurred_at >= ? AND occurred_at <= ? AND source = ?
       ORDER BY occurred_at ASC`
    : `SELECT id, source, payload, occurred_at
       FROM activity_events
       WHERE occurred_at >= ? AND occurred_at <= ?
       ORDER BY occurred_at ASC`;

  const rows = source
    ? await db.prepare(query).bind(start, end, source).all<ActivityEventRow>()
    : await db.prepare(query).bind(start, end).all<ActivityEventRow>();

  return (rows.results ?? []).map((row: ActivityEventRow) => ({
    id: row.id,
    source: row.source,
    payload: row.payload ? JSON.parse(row.payload) : null,
    occurredAt: row.occurred_at,
  }));
}

/**
 * Insert a summary.
 */
export async function insertSummary(
  db: CloudDatabase,
  sessionId: string | null,
  rangeStart: string,
  rangeEnd: string,
  summary: unknown
): Promise<string> {
  const id = generateId();
  const now = nowISO();
  await db
    .prepare(
      `INSERT INTO summaries (id, session_id, range_start, range_end, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, sessionId, rangeStart, rangeEnd, JSON.stringify(summary), now)
    .run();
  return id;
}
