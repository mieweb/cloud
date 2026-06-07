import { makeRedis } from './kv-valkey.mjs';

/**
 * Queues → Valkey/Redis adapter (os.mieweb.org target).
 *
 * Producer `send(body, { delaySeconds })` / `sendBatch` push onto a Valkey
 * list (`<ns>:q:<name>`); delayed messages wait in a sorted set keyed by
 * delivery time. A lightweight poller drains due messages in batches and
 * invokes the worker's own `queue(batch, env)` handler — the exact handler
 * Cloudflare calls — with working `ack()`/`retry()` (retry re-enqueues, with
 * optional delay). Unlike the in-process local adapter, messages survive a
 * worker restart because they live in Valkey.
 *
 * The host starts the poller once the env (and thus the consumer) is wired;
 * tests can call `_start()` / `_stop()` directly.
 *
 * @param {string} queueName
 * @param {() => import('@mieweb/cloud-local').QueueConsumer|undefined} getConsumer
 * @param {() => unknown} getEnv
 * @param {{ url?: string, host?: string, port?: number, namespace?: string, batchSize?: number, pollMs?: number }} cfg
 * @returns {Promise<import('@mieweb/cloud-local').LocalQueue & { _start: () => void, _stop: () => void, _close: () => Promise<void> }>}
 */
export async function createValkeyQueue(queueName, getConsumer, getEnv, cfg) {
  const client = await makeRedis(cfg);
  const ns = cfg.namespace ?? 'mq';
  const listKey = `${ns}:q:${queueName}`;
  const delayedKey = `${ns}:q:${queueName}:delayed`;
  const batchSize = cfg.batchSize ?? 10;
  const pollMs = cfg.pollMs ?? 150;

  let timer = null;
  let draining = false;

  /** @param {unknown} body @param {number} attempts @param {number} [deliverAt] ms epoch */
  async function enqueue(body, attempts, deliverAt) {
    const payload = JSON.stringify({ body, attempts });
    if (deliverAt && deliverAt > Date.now()) {
      await client.zadd(delayedKey, deliverAt, payload);
    } else {
      await client.rpush(listKey, payload);
    }
  }

  async function promoteDue() {
    const now = Date.now();
    const due = await client.zrangebyscore(delayedKey, 0, now);
    if (!due.length) return;
    const pipe = client.multi();
    for (const payload of due) {
      pipe.rpush(listKey, payload);
      pipe.zrem(delayedKey, payload);
    }
    await pipe.exec();
  }

  async function drainOnce() {
    if (draining) return;
    draining = true;
    try {
      await promoteDue();
      // Atomically pop up to batchSize messages.
      const popped = await client.lpop(listKey, batchSize);
      const items = Array.isArray(popped) ? popped : popped ? [popped] : [];
      if (!items.length) return;

      const consumer = getConsumer();
      if (!consumer) {
        // No consumer wired yet — put them back, try again next tick.
        if (items.length) await client.lpush(listKey, ...items.reverse());
        return;
      }

      const messages = items.map((payload, i) => {
        const parsed = JSON.parse(payload);
        return makeMessage(`${queueName}-${Date.now()}-${i}`, parsed, (delayMs) =>
          enqueue(parsed.body, parsed.attempts + 1, delayMs ? Date.now() + delayMs : undefined),
        );
      });

      const batch = {
        queue: queueName,
        messages,
        ackAll() {
          for (const m of messages) m.ack();
        },
        retryAll() {
          for (const m of messages) m.retry();
        },
      };

      try {
        await consumer(batch, getEnv());
        // Cloudflare auto-acks anything not explicitly retried on success.
        for (const m of messages) m.ack();
      } catch (err) {
        console.error(`[mieweb] queue "${queueName}" handler threw`, err);
        for (const m of messages) m.retry();
      }
    } finally {
      draining = false;
    }
  }

  function start() {
    if (timer) return;
    const tick = async () => {
      try {
        await drainOnce();
      } catch (err) {
        console.error(`[mieweb] queue "${queueName}" poller error`, err);
      }
      timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // Start draining immediately; ticks no-op until a consumer is wired and a
  // message arrives, so it's safe to start before the rest of the env exists.
  start();

  return {
    /**
     * @param {unknown} body
     * @param {{ delaySeconds?: number }} [opts]
     */
    async send(body, opts) {
      const deliverAt = opts?.delaySeconds ? Date.now() + opts.delaySeconds * 1000 : undefined;
      await enqueue(body, 1, deliverAt);
    },
    /** @param {Array<{ body: unknown }>} messages */
    async sendBatch(messages) {
      for (const m of messages) await enqueue(m.body, 1);
    },
    _start: start,
    _stop: stop,
    async _close() {
      stop();
      await client.quit();
    },
  };
}

/**
 * @param {string} id
 * @param {{ body: unknown, attempts: number }} parsed
 * @param {(delayMs?: number) => Promise<void>} onRetry
 */
function makeMessage(id, parsed, onRetry) {
  let settled = false;
  return {
    id,
    timestamp: new Date(),
    attempts: parsed.attempts,
    body: parsed.body,
    ack() {
      settled = true;
    },
    /** @param {{ delaySeconds?: number }} [opts] */
    retry(opts) {
      if (settled) return;
      settled = true;
      void onRetry(opts?.delaySeconds ? opts.delaySeconds * 1000 : undefined);
    },
  };
}
