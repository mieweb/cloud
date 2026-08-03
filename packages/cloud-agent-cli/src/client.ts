/**
 * HTTP client for agent communication.
 * Supports streaming (SSE) and fire-and-forget modes.
 */

import type { StreamEvent } from "./types.js";

interface RequestOptions {
  profile?: unknown;
  cwd?: string;
}

/**
 * Send a message and stream the response.
 * Uses Server-Sent Events for real-time streaming.
 */
export async function* streamCall(
  baseUrl: string,
  sessionId: string,
  message: string,
  options: RequestOptions
): AsyncGenerator<StreamEvent> {
  const url = `${baseUrl}/v1/sessions/${sessionId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify({
      message,
      profile: options.profile,
      context: { cwd: options.cwd },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMessage: string;
    try {
      const json = JSON.parse(text);
      errorMessage = json.error ?? text;
    } catch {
      errorMessage = text;
    }
    yield { type: "error", message: errorMessage };
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Handle SSE streaming
  if (contentType.includes("text/event-stream")) {
    yield* parseSSE(response);
    return;
  }

  // Handle JSON response (non-streaming)
  const json = await response.json() as {
    ok?: boolean;
    message?: string;
    status?: string;
    suspended?: boolean;
    error?: string;
    toolsUsed?: string[];
  };

  if (json.error) {
    yield { type: "error", message: json.error };
    return;
  }

  yield { type: "start" };

  if (json.message) {
    yield { type: "text", text: json.message };
  }

  const toolsUsed = json.toolsUsed?.length ? json.toolsUsed : undefined;

  if (json.suspended) {
    yield {
      type: "suspended",
      reason: json.status ?? "waiting_for_user",
      message: json.message,
      toolsUsed,
    };
  } else {
    yield { type: "finish", finishReason: "stop", toolsUsed };
  }
}

/**
 * Parse Server-Sent Events from a response.
 */
async function* parseSSE(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", message: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            yield { type: "finish", finishReason: "stop" };
            return;
          }

          try {
            const event = JSON.parse(data);
            yield normalizeEvent(event);
          } catch {
            // Ignore malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function toToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((name) => String(name));
}

/**
 * Normalize server event to StreamEvent.
 */
function normalizeEvent(event: unknown): StreamEvent {
  if (typeof event !== "object" || event === null) {
    return { type: "error", message: "Invalid event" };
  }

  const e = event as Record<string, unknown>;

  switch (e.type) {
    case "start":
      return { type: "start" };
    case "text-delta":
    case "text":
      return { type: "text", text: String(e.text ?? "") };
    case "tool-call":
      return {
        type: "tool-call",
        toolName: String(e.toolName ?? ""),
        input: e.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolName: String(e.toolName ?? ""),
        output: e.output,
      };
    case "finish":
      return {
        type: "finish",
        finishReason: String(e.finishReason ?? "stop"),
        toolsUsed: toToolNames(e.toolsUsed),
      };
    case "error":
      return { type: "error", message: String(e.message ?? "Unknown error") };
    case "suspend":
    case "suspended":
      return {
        type: "suspended",
        reason: String(e.reason ?? "waiting_for_user"),
        message: e.message as string | undefined,
        toolsUsed: toToolNames(e.toolsUsed),
      };
    default:
      return { type: "error", message: `Unknown event type: ${e.type}` };
  }
}

/**
 * Send a message and return immediately (fire-and-forget).
 * The agent processes the message asynchronously.
 */
export async function fireAndForget(
  baseUrl: string,
  sessionId: string,
  message: string,
  options: RequestOptions
): Promise<{ eventId: string; status: string }> {
  const url = `${baseUrl}/v1/sessions/${sessionId}/enqueue`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      profile: options.profile,
      context: { cwd: options.cwd },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${text}`);
  }

  const json = await response.json() as { eventId: string; status: string };
  return json;
}

/**
 * Get session status.
 */
export async function getStatus(
  baseUrl: string,
  sessionId: string
): Promise<{ status: string; continuation?: unknown }> {
  const url = `${baseUrl}/v1/sessions/${sessionId}/status`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed: ${text}`);
  }

  return response.json() as Promise<{ status: string; continuation?: unknown }>;
}
