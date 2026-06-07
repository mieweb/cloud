/**
 * Queues → in-process adapter.
 *
 * A producer `.send(body)` / `.sendBatch(bodies)` schedules delivery on the
 * next tick to the application's own `queue(batch, env)` handler — the exact
 * same handler Cloudflare invokes. Messages support `ack()` (default) and
 * `retry()` (re-delivers once, after a short delay) so consumer code that
 * calls `msg.retry()` behaves sensibly locally.
 *
 * This is intentionally simple: no persistence, no dead-letter, no batching
 * window. It exists so background work (summaries, embeddings, lookups) runs
 * end-to-end in local dev without standing up a real broker. Swap for Redis /
 * SQS by implementing the same `{ send, sendBatch }` shape.
 *
 * @param {string} queueName the wrangler queue name (e.g. 'summarize-calls')
 * @param {() => import('../index.mjs').QueueConsumer|undefined} getConsumer
 *   late-bound accessor for the worker's queue handler (wired by the host)
 * @param {() => unknown} getEnv late-bound accessor for the built Env
 * @returns {import('../index.mjs').LocalQueue}
 */
export function createInprocQueue(queueName, getConsumer, getEnv) {
  let seq = 0;

  /**
   * @param {unknown} body
   * @param {number} [delayMs]
   */
  function enqueue(body, delayMs = 0) {
    const message = makeMessage(`${queueName}-${seq++}`, body, (retryDelayMs) =>
      enqueue(body, retryDelayMs ?? 1000),
    );
    const deliver = () => {
      const consumer = getConsumer();
      if (!consumer) {
        console.warn(`[mieweb] no queue consumer wired for "${queueName}"`);
        return;
      }
      const batch = {
        queue: queueName,
        messages: [message],
        ackAll() {},
        retryAll() {
          message.retry();
        },
      };
      Promise.resolve(consumer(batch, getEnv())).catch((err) =>
        console.error(`[mieweb] queue "${queueName}" handler threw`, err),
      );
    };
    if (delayMs > 0) setTimeout(deliver, delayMs);
    else queueMicrotask(deliver);
  }

  return {
    /**
     * @param {unknown} body
     * @param {{ delaySeconds?: number }} [opts]
     */
    async send(body, opts) {
      enqueue(body, (opts?.delaySeconds ?? 0) * 1000);
    },
    /** @param {Array<{ body: unknown }>} messages */
    async sendBatch(messages) {
      for (const m of messages) enqueue(m.body);
    },
  };
}

/**
 * @param {string} id
 * @param {unknown} body
 * @param {(delayMs?: number) => void} onRetry
 */
function makeMessage(id, body, onRetry) {
  let settled = false;
  return {
    id,
    timestamp: new Date(),
    attempts: 1,
    body,
    ack() {
      settled = true;
    },
    /** @param {{ delaySeconds?: number }} [opts] */
    retry(opts) {
      if (settled) return;
      settled = true;
      onRetry(opts?.delaySeconds ? opts.delaySeconds * 1000 : undefined);
    },
  };
}
