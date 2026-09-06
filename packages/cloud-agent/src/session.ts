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
  createRuntime: (profile?: unknown) => AgentRuntime,
  createTools?: (ctx: ToolContext) => unknown
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

      const eventId = await insertEvent(
        this.env.DB,
        sessionId,
        "scheduled_wake",
        payload
      );

      await this.env.JOBS.send({
        sessionId,
        eventId,
        scheduledPayload: payload,
      });

      await this.state.storage.delete("alarm_payload");
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
     * Handle incoming message - delegate to handleTurn for persistence and execution.
     */
    private async handleMessage(
      request: Request,
      sessionId: string
    ): Promise<Response> {
      const { message, userId, profile } = await request.json() as {
        message: string;
        userId?: string;
        profile?: unknown;
      };

      const turnRequest = new Request("http://internal/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          eventId: crypto.randomUUID(),
          message,
          userId,
          profile,
        } satisfies TurnJob),
      });

      return this.handleTurn(turnRequest, sessionId);
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
        const job = await request.json() as TurnJob;
        const session = await getOrCreateSession(
          this.env.DB,
          sessionId,
          job.userId
        );

        if (session.status === "running") {
          return json(
            { error: "Turn already in progress", status: session.status },
            409
          );
        }

        if (job.message) {
          const isResume =
            session.status === "waiting_for_user" ||
            session.status === "waiting_for_approval";

          await insertEvent(this.env.DB, sessionId, "user_message", {
            message: job.message,
          });
          await insertMessage(this.env.DB, sessionId, "user", job.message);

          if (isResume) {
            await insertEvent(this.env.DB, sessionId, "resumed");
          }
        }

        await updateSessionStatus(this.env.DB, sessionId, "running");

        const messages = await getSessionMessages(this.env.DB, sessionId);
        const coreMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const runtime = createRuntime(job.profile);

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

        const tools = createTools?.(toolContext) ?? agent.tools;

        let assistantContent = "";
        let finishReason = "stop";
        /** Tool names invoked this turn, unique, in order of first call. */
        const toolsUsed: string[] = [];

        for await (const event of runtime.runTurn({
          messages: coreMessages,
          tools,
          system: agent.instructions,
          maxSteps: 10,
        })) {
          if (event.type === "text-delta") {
            assistantContent += event.text;
          } else if (event.type === "tool-call") {
            if (!toolsUsed.includes(event.toolName)) {
              toolsUsed.push(event.toolName);
            }
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
            toolsUsed,
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
          toolsUsed,
        });
      } catch (err) {
        await insertEvent(this.env.DB, sessionId, "error", {
          message: String(err instanceof Error ? err.message : err),
        });
        await updateSessionStatus(this.env.DB, sessionId, "idle");
        return json(
          { error: String(err instanceof Error ? err.message : err) },
          500
        );
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
