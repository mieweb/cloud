/**
 * @mieweb/cloud-agent — Event-driven agent host for @mieweb/cloud.
 *
 * Binds an agent definition + AgentRuntime to a Durable Object with
 * queue-driven turns, suspend/resume, and alarms.
 *
 * @example
 * ```ts
 * import { hostAgent } from '@mieweb/cloud-agent';
 *
 * const { SessionClass, handleFetch, handleQueue } = hostAgent({
 *   agent: { name: 'jerry', instructions: '...', tools: [...] },
 *   createRuntime: (profile) => resolveRuntime(profile),
 *   store: { db: env.DB },
 * });
 *
 * export { SessionClass as AgentSession };
 * export default {
 *   fetch: (req, env) => handleFetch(req, env),
 *   queue: (batch, env) => handleQueue(batch, env),
 * };
 * ```
 */

export { hostAgent } from "./host.js";
export { createSessionClass } from "./session.js";
export {
  initSchema,
  getOrCreateSession,
  updateSessionStatus,
  insertEvent,
  getSessionEvents,
  insertMessage,
  getSessionMessages,
  insertActivityEvent,
  getActivityEvents,
  insertSummary,
} from "./storage.js";
export type {
  SessionStatus,
  EventType,
  LifecycleEvent,
  MessageRole,
  ConversationMessage,
  ContinuationState,
  Session,
  TurnJob,
  AgentDefinition,
  AgentRuntime,
  TurnInput,
  RuntimeEvent,
  HostStore,
  Trigger,
  HostEnv,
  HostAgentConfig,
  ToolContext,
  HostAgentResult,
  AgentSessionDO,
} from "./types.js";
