/**
 * AgentSession Durable Object.
 * Handles the agent turn lifecycle: queue-driven turns, suspend/resume, alarms.
 */

import type { CloudStatefulState } from "@mieweb/cloud-types";
import type {
  HostEnv,
  AgentDefinition,
  AgentRuntime,
  TurnJob,
  ContinuationState,
  ToolContext,
} from "./types.js";
import {
  getOrCreateSession,
  updateSessionStatus,
  insertEvent,
  insertMessage,
  getSessionMessages,
  initSchema,
} from "./storage.js";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Creates an AgentSession DO class bound to the given agent definition and runtime factory.
 */
export function createSessionClass(
  agent: AgentDefinition,
  createRuntime: (profile?: unknown) => AgentRuntime
) {
  return class AgentSession {
    private state: CloudStatefulState;
    private env: HostEnv;
    private turnInProgress = false;
    private suspendReason: "waiting_for_user" | "waiting_for_approval" | null = null;
    private suspendMessage: string | null = null;

    constructor(state: CloudStatefulState, env: HostEnv) {
      this.state = state;
      this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const sessionId = this.state.id.toString();

      try {
        await initSchema(this.env.DB);

        if (url.pathname === "/status") {
          return this.handleStatus(sessionId);
        }

        if (url.pathname === "/message" && request.method === "POST") {
          return this.handleMessage(request, sessionId);
        }

        if (url.pathname === "/turn" && request.method === "POST") {
          return this.handleTurn(request, sessionId);
        }

        if (url.pathname === "/alarm" && request.method === "POST") {
          return this.handleAlarmTrigger(request, sessionId);
        }

        return json({ error: "not found", path: url.pathname }, 404);
      } catch (err) {
        console.error("AgentSession error:", err);
        return json(
          { error: String(err instanceof Error ? err.message : err) },
          500
        );
      }
    }

    /**
     * Alarm handler - fires when a scheduled wake occurs.
     */
    async alarm(): Promise<void> {
      const sessionId = this.state.id.toString();
      const payload = await this.state.storage.get<unknown>("alarm_payload");
      await this.state.storage.delete("alarm_payload");

      await insertEvent(this.env.DB, sessionId, "scheduled_wake", payload);

      await this.env.JOBS.send({
        sessionId,
        eventId: crypto.randomUUID(),
        scheduledPayload: payload,
      });
    }

    /**
     * Get session status.
     */
    private async handleStatus(sessionId: string): Promise<Response> {
      const session = await getOrCreateSession(this.env.DB, sessionId);
      return json({
        sessionId,
        status: session.status,
        continuation: session.continuation,
      });
    }

    /**
     * Handle incoming message - record event and enqueue turn.
     */
    private async handleMessage(
      request: Request,
      sessionId: string
    ): Promise<Response> {
      const { message, userId, profile: _profile } = await request.json() as {
        message: string;
        userId?: string;
        profile?: unknown;
      };

      const session = await getOrCreateSession(this.env.DB, sessionId, userId);

      if (session.status === "running") {
        return json(
          { error: "Turn already in progress", status: session.status },
          409
        );
      }

      const eventId = await insertEvent(this.env.DB, sessionId, "user_message", {
        message,
      });
      await insertMessage(this.env.DB, sessionId, "user", message);

      const isResume =
        session.status === "waiting_for_user" ||
        session.status === "waiting_for_approval";

      if (isResume) {
        await insertEvent(this.env.DB, sessionId, "resumed");
      }

      await this.env.JOBS.send({
        sessionId,
        eventId,
        message,
        isResume,
      });

      await updateSessionStatus(this.env.DB, sessionId, "running");

      return json({
        ok: true,
        sessionId,
        eventId,
        status: "queued",
        wasResume: isResume,
      });
    }

    /**
     * Handle a turn job (called from queue consumer via fetch).
     */
    private async handleTurn(
      request: Request,
      sessionId: string
    ): Promise<Response> {
      if (this.turnInProgress) {
        return json({ error: "Turn already in progress" }, 409);
      }

      this.turnInProgress = true;
      this.suspendReason = null;
      this.suspendMessage = null;

      try {
        // Read job from request (used for context, e.g. scheduledPayload)
        const job = await request.json() as TurnJob;
        void job; // Used in future for scheduledPayload handling
        // Ensure session exists (also validates sessionId)
        await getOrCreateSession(this.env.DB, sessionId);

        const messages = await getSessionMessages(this.env.DB, sessionId);
        const coreMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const runtime = createRuntime();

        // Tool context for tools to access bindings and control flow
        // TODO: Pass this to tools when they're implemented
        const toolContext: ToolContext = {
          sessionId,
          db: this.env.DB,
          vectors: this.env.VECTORS,
          bucket: this.env.BUCKET,
          scheduleWake: async (at, payload) => {
            const when = typeof at === "string" ? new Date(at) : at;
            await this.state.storage.put("alarm_payload", payload);
            await this.state.storage.setAlarm(when);
          },
          suspendForUser: (message) => {
            this.suspendReason = "waiting_for_user";
            this.suspendMessage = message;
          },
          suspendForApproval: (message) => {
            this.suspendReason = "waiting_for_approval";
            this.suspendMessage = message;
          },
        };
        void toolContext; // Will be passed to tools when implemented

        let assistantContent = "";
        let finishReason = "stop";

        for await (const event of runtime.runTurn({
          messages: coreMessages,
          tools: agent.tools,
          system: agent.instructions,
          maxSteps: 10,
        })) {
          if (event.type === "text-delta") {
            assistantContent += event.text;
          } else if (event.type === "finish") {
            finishReason = event.finishReason;
          } else if (event.type === "suspend") {
            this.suspendReason = event.reason;
            this.suspendMessage = event.message ?? null;
          } else if (event.type === "error") {
            await insertEvent(this.env.DB, sessionId, "error", {
              message: event.message,
            });
            await updateSessionStatus(this.env.DB, sessionId, "idle");
            return json({ error: event.message }, 500);
          }
        }

        if (this.suspendReason) {
          const continuation: ContinuationState = {
            pendingMessage: this.suspendMessage ?? undefined,
            suspendedAt: new Date().toISOString(),
            reason: this.suspendReason,
          };

          await insertMessage(this.env.DB, sessionId, "assistant", assistantContent || this.suspendMessage);
          await insertEvent(this.env.DB, sessionId, this.suspendReason, {
            message: this.suspendMessage,
          });
          await updateSessionStatus(this.env.DB, sessionId, this.suspendReason, continuation);

          return json({
            ok: true,
            sessionId,
            status: this.suspendReason,
            message: assistantContent || this.suspendMessage,
            suspended: true,
          });
        }

        if (assistantContent) {
          await insertMessage(this.env.DB, sessionId, "assistant", assistantContent);
          await insertEvent(this.env.DB, sessionId, "agent_message", {
            content: assistantContent,
            finishReason,
          });
        }

        await updateSessionStatus(this.env.DB, sessionId, "idle");

        return json({
          ok: true,
          sessionId,
          status: "idle",
          message: assistantContent,
          finishReason,
        });
      } finally {
        this.turnInProgress = false;
      }
    }

    /**
     * Handle alarm trigger (for internal routing).
     */
    private async handleAlarmTrigger(
      _request: Request,
      sessionId: string
    ): Promise<Response> {
      await this.alarm();
      return json({ ok: true, sessionId, alarm: "triggered" });
    }
  };
}
