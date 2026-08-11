/**
 * Minimal worker that mounts @mieweb/cloud-agent on the Workers runtime.
 *
 * Uses a stub runtime so the smoke test exercises the host (Durable Object,
 * D1 storage, Queues) without needing a model provider.
 */

import { hostAgent } from "../src/index.js";
import type { AgentRuntime, RuntimeEvent, HostEnv, TurnJob } from "../src/types.js";
import type { CloudMessageBatch } from "@mieweb/cloud-types";

const stubRuntime: AgentRuntime = {
  async *runTurn(): AsyncIterable<RuntimeEvent> {
    yield { type: "start" };
    yield { type: "text-delta", text: "cloud-agent running on workerd" };
    yield { type: "finish", finishReason: "stop" };
  },
};

const host = hostAgent({
  agent: { name: "smoke", instructions: "smoke test agent" },
  createRuntime: () => stubRuntime,
  store: { db: null as never },
});

export const AgentSession = host.SessionClass;

export default {
  fetch: (request: Request, env: HostEnv) => host.handleFetch(request, env),
  queue: (batch: CloudMessageBatch<TurnJob>, env: HostEnv) =>
    host.handleQueue(batch, env),
};
