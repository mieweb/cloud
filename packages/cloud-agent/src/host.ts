/**
 * hostAgent() — binds an agent definition + AgentRuntime to a Durable Object
 * with queue-driven turns, suspend/resume, and alarms.
 */

import type {
  HostAgentConfig,
  HostAgentResult,
  HostEnv,
  TurnJob,
} from "./types.js";
import { createSessionClass } from "./session.js";
import { initSchema, insertActivityEvent } from "./storage.js";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Extract session ID from request.
 * Looks for :id in path /v1/sessions/:id/... or X-Session-Id header.
 */
function extractSessionId(request: Request): string | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/v1\/sessions\/([^/]+)/);
  if (match) return match[1];
  return request.headers.get("X-Session-Id");
}

/**
 * Extract user ID from request headers.
 */
function extractUserId(request: Request): string | undefined {
  return request.headers.get("X-User-Id") ?? undefined;
}

/**
 * hostAgent() creates the wiring for an event-driven agent.
 *
 * Returns:
 * - SessionClass: The DO class to export from the worker
 * - handleFetch: Routes fetch requests to the appropriate DO
 * - handleQueue: Processes queue messages by forwarding to DOs
 * - handleScheduled: Optional cron handler
 */
export function hostAgent(config: HostAgentConfig): HostAgentResult {
  const { agent, createRuntime } = config;

  const SessionClass = createSessionClass(agent, createRuntime);

  async function handleFetch(
    request: Request,
    env: HostEnv
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    await initSchema(env.DB);

    if (path === "/health") {
      return json({ ok: true, agent: agent.name });
    }

    if (path === "/v1/events" && request.method === "POST") {
      const events = await request.json() as Array<{
        source: string;
        payload: unknown;
        occurredAt: string;
      }>;

      const ids: string[] = [];
      for (const event of events) {
        const id = await insertActivityEvent(
          env.DB,
          event.source,
          event.payload,
          event.occurredAt
        );
        ids.push(id);
      }

      return json({ ok: true, count: ids.length, ids });
    }

    const sessionId = extractSessionId(request);
    if (!sessionId) {
      return json({ error: "Missing session ID" }, 400);
    }

    const id = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(id);

    if (path.endsWith("/messages") && request.method === "POST") {
      const body = await request.json() as { message: string; profile?: unknown };
      const userId = extractUserId(request);

      const doRequest = new Request(`${url.origin}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: body.message,
          userId,
          profile: body.profile,
        }),
      });

      return stub.fetch(doRequest);
    }

    if (path.endsWith("/enqueue") && request.method === "POST") {
      const body = await request.json() as { message: string };

      const eventId = crypto.randomUUID();
      await env.JOBS.send({
        sessionId,
        eventId,
        message: body.message,
      });

      return json({ ok: true, sessionId, eventId, status: "queued" });
    }

    if (path.endsWith("/status")) {
      const doRequest = new Request(`${url.origin}/status`);
      return stub.fetch(doRequest);
    }

    return json({ error: "Not found", path }, 404);
  }

  async function handleQueue(
    batch: { messages: Array<{ body: TurnJob; ack: () => void }> },
    env: HostEnv
  ): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;

      try {
        const id = env.SESSION.idFromName(job.sessionId);
        const stub = env.SESSION.get(id);

        const response = await stub.fetch(
          new Request("http://internal/turn", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(job),
          })
        );

        if (!response.ok) {
          const error = await response.text();
          console.error(`Turn failed for session ${job.sessionId}:`, error);
        }

        message.ack();
      } catch (err) {
        console.error(`Queue processing error for session ${job.sessionId}:`, err);
        message.ack();
      }
    }
  }

  async function handleScheduled(
    event: { cron: string },
    _env: HostEnv
  ): Promise<void> {
    console.log(`Scheduled event: ${event.cron}`);
  }

  return {
    SessionClass,
    handleFetch,
    handleQueue,
    handleScheduled,
  };
}
