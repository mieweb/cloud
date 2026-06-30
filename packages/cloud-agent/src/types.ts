/**
 * @mieweb/cloud-agent type definitions
 *
 * Types for the event-driven agent host that binds an agent definition +
 * AgentRuntime to a Durable Object with queue-driven turns, suspend/resume,
 * and alarms.
 */

import type {
  CloudDatabase,
  CloudQueue,
  CloudStatefulNamespace,
  CloudStatefulState,
  CloudVectorIndex,
  CloudBucket,
} from "@mieweb/cloud-types";

/**
 * Session status states.
 * - `idle`: No turn in progress, ready for new messages
 * - `running`: Turn currently executing
 * - `waiting_for_user`: Agent asked a question, waiting for user response
 * - `waiting_for_approval`: Tool needs human approval
 * - `scheduled`: Alarm scheduled for future wake
 */
export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "scheduled";

/**
 * Event types in the lifecycle log.
 */
export type EventType =
  | "user_message"
  | "agent_message"
  | "external"
  | "scheduled_wake"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "resumed"
  | "error";

/**
 * A lifecycle event in the event log.
 */
export interface LifecycleEvent {
  id: string;
  sessionId: string;
  type: EventType;
  payload: unknown;
  createdAt: string;
}

/**
 * Conversation message role.
 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * A message in the conversation history.
 */
export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
}

/**
 * Continuation state for suspend/resume.
 * Persisted when the agent suspends waiting for user input or approval.
 */
export interface ContinuationState {
  /** The pending question or approval request */
  pendingMessage?: string;
  /** Partial tool call state if suspended mid-tool */
  partialToolState?: unknown;
  /** Timestamp when suspension occurred */
  suspendedAt: string;
  /** Reason for suspension */
  reason: "waiting_for_user" | "waiting_for_approval";
}

/**
 * Session record in the database.
 */
export interface Session {
  id: string;
  userId?: string;
  status: SessionStatus;
  conversationId?: string;
  continuation?: ContinuationState;
  createdAt: string;
  updatedAt: string;
}

/**
 * Turn job queued for processing.
 */
export interface TurnJob {
  sessionId: string;
  eventId: string;
  message?: string;
  isResume?: boolean;
  scheduledPayload?: unknown;
  /** Privacy profile override from the request (runtime, model, egress). */
  profile?: unknown;
}

/**
 * Agent definition: instructions and tools.
 */
export interface AgentDefinition {
  /** Agent name (used for routing) */
  name: string;
  /** System instructions / persona */
  instructions: string;
  /** Tools available to the agent (will be passed to runtime) */
  tools?: unknown;
}

/**
 * Minimal AgentRuntime interface expected by the host.
 * Matches the AgentRuntime port from @mieweb/jerry-agent-runtime.
 */
export interface AgentRuntime {
  /** Execute a turn and yield events */
  runTurn(input: TurnInput): AsyncIterable<RuntimeEvent>;
}

/**
 * Input for a single turn of the agent runtime.
 */
export interface TurnInput {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  system?: string;
  maxSteps?: number;
}

/**
 * Events emitted during a turn.
 */
export type RuntimeEvent =
  | { type: "start" }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | { type: "finish"; finishReason: string; usage?: unknown }
  | { type: "error"; message: string; cause?: unknown }
  | { type: "suspend"; reason: "waiting_for_user" | "waiting_for_approval"; message?: string };

/**
 * Store bindings required by the host.
 */
export interface HostStore {
  db: CloudDatabase;
  vectors?: CloudVectorIndex;
  bucket?: CloudBucket;
}

/**
 * Trigger definition for the host.
 */
export type Trigger =
  | { type: "fetch"; path: string; method?: string }
  | { type: "queue"; topic?: string }
  | { type: "scheduled"; cron: string };

/**
 * Environment bindings expected by the host.
 */
export interface HostEnv {
  DB: CloudDatabase;
  JOBS: CloudQueue<TurnJob>;
  SESSION: CloudStatefulNamespace;
  VECTORS?: CloudVectorIndex;
  BUCKET?: CloudBucket;
}

/**
 * Host configuration for hostAgent().
 */
export interface HostAgentConfig {
  /** Agent definition (name, instructions, tools) */
  agent: AgentDefinition;
  /** Factory function to create runtime for a turn (receives profile from request) */
  createRuntime: (profile?: unknown) => AgentRuntime;
  /**
   * Build tools for a turn from host bindings (DB, vectors, alarms, …).
   * When omitted, static `agent.tools` is used.
   */
  createTools?: (ctx: ToolContext) => unknown;
  /** Store bindings (built from env) */
  store: HostStore;
  /** Trigger definitions (optional, defaults to standard routes) */
  triggers?: Trigger[];
}

/**
 * Tool context passed to tools during execution.
 */
export interface ToolContext {
  sessionId: string;
  db: CloudDatabase;
  vectors?: CloudVectorIndex;
  bucket?: CloudBucket;
  /** Schedule a future wake-up */
  scheduleWake: (at: Date | string, payload?: unknown) => Promise<void>;
  /** Suspend the turn waiting for user input */
  suspendForUser: (message: string) => void;
  /** Suspend the turn waiting for approval */
  suspendForApproval: (message: string) => void;
}

/**
 * Result from hostAgent() - wiring helpers for the worker.
 */
export interface HostAgentResult {
  /** The DO class to export */
  SessionClass: new (state: CloudStatefulState, env: HostEnv) => AgentSessionDO;
  /** Handle a fetch request (routes to DO) */
  handleFetch: (
    request: Request,
    env: HostEnv
  ) => Promise<Response>;
  /** Handle a queue batch (forwards to DO) */
  handleQueue: (
    batch: { messages: Array<{ body: TurnJob; ack: () => void }> },
    env: HostEnv
  ) => Promise<void>;
  /** Handle scheduled events (optional) */
  handleScheduled?: (event: { cron: string }, env: HostEnv) => Promise<void>;
}

/**
 * The AgentSession Durable Object interface.
 */
export interface AgentSessionDO {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
}
