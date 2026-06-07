/**
 * Durable Objects → in-process registry adapter ("Artipods", local flavor).
 *
 * One JS instance per `idFromName(name)`, cached for the lifetime of the
 * process, constructed as `new Klass(state, env)` — the same constructor
 * signature `DurableObject<Env>` uses on Cloudflare. The provided `state`
 * implements the `DurableObjectState` surface the app actually touches:
 *
 *   * storage: get/put/delete/list  (in-memory Map)
 *   * storage: getAlarm/setAlarm/deleteAlarm  (setTimeout-backed → alarm())
 *   * blockConcurrencyWhile(fn)
 *   * waitUntil(promise)
 *   * acceptWebSocket / getWebSockets / serializeAttachment / deserializeAttachment
 *     (single-process, non-hibernating: sockets simply stay in memory)
 *
 * Caveats vs Cloudflare (acceptable for local dev, see migration notes):
 *   * No cross-process placement, no true hibernation, no input/output gates.
 *   * Single-process only — fine for `mieweb dev`, not a cluster.
 *
 * @param {string} className the DO class name (for diagnostics)
 * @param {() => (new (state: any, env: any) => any)} getClass late-bound class accessor
 * @param {() => unknown} getEnv late-bound Env accessor
 * @returns {import('../index.mjs').LocalDurableNamespace}
 */
export function createInprocNamespace(className, getClass, getEnv) {
  /** @type {Map<string, any>} */
  const instances = new Map();

  /** @param {string} name */
  function makeId(name) {
    return {
      name,
      toString() {
        return name;
      },
      equals(/** @type {{ toString(): string }} */ other) {
        return other?.toString() === name;
      },
    };
  }

  /** @param {string} name */
  function instanceFor(name) {
    let inst = instances.get(name);
    if (!inst) {
      const Klass = getClass();
      const state = createState(name, () => instances.get(name));
      inst = new Klass(state, getEnv());
      instances.set(name, inst);
    }
    return inst;
  }

  return {
    /** @param {string} name */
    idFromName(name) {
      return makeId(name);
    },
    /** @param {string} hex */
    idFromString(hex) {
      return makeId(hex);
    },
    newUniqueId() {
      return makeId(`uniq-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);
    },
    /** @param {{ toString(): string }} id */
    get(id) {
      const name = id.toString();
      return {
        id,
        /**
         * @param {RequestInfo|URL} input
         * @param {RequestInit} [init]
         */
        fetch(input, init) {
          const req = input instanceof Request ? input : new Request(input, init);
          const inst = instanceFor(name);
          if (typeof inst.fetch !== 'function') {
            return Promise.resolve(
              new Response(`DO ${className} has no fetch()`, { status: 500 }),
            );
          }
          return inst.fetch(req);
        },
      };
    },
  };
}

/**
 * Build a DurableObjectState-compatible shim.
 * @param {string} name
 * @param {() => any} getInstance accessor so the alarm can invoke alarm()
 */
function createState(name, getInstance) {
  /** @type {Map<string, unknown>} */
  const kv = new Map();
  /** @type {Set<any>} */
  const sockets = new Set();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let alarmTimer = null;
  /** @type {number|null} */
  let alarmAt = null;

  const storage = {
    /** @param {string} key */
    async get(key) {
      return kv.has(key) ? kv.get(key) : undefined;
    },
    /** @param {string} key @param {unknown} value */
    async put(key, value) {
      kv.set(key, value);
    },
    /** @param {string} key */
    async delete(key) {
      return kv.delete(key);
    },
    async list() {
      return new Map(kv);
    },
    async getAlarm() {
      return alarmAt;
    },
    /** @param {number} scheduledTime epoch ms */
    async setAlarm(scheduledTime) {
      if (alarmTimer) clearTimeout(alarmTimer);
      alarmAt = scheduledTime;
      const delay = Math.max(0, scheduledTime - Date.now());
      alarmTimer = setTimeout(() => {
        alarmTimer = null;
        alarmAt = null;
        const inst = getInstance();
        if (inst && typeof inst.alarm === 'function') {
          Promise.resolve(inst.alarm()).catch((err) =>
            console.error(`[mieweb] DO ${name} alarm() threw`, err),
          );
        }
      }, delay);
    },
    async deleteAlarm() {
      if (alarmTimer) clearTimeout(alarmTimer);
      alarmTimer = null;
      alarmAt = null;
    },
  };

  return {
    id: { name, toString: () => name },
    storage,
    /** @param {() => Promise<unknown>} fn */
    async blockConcurrencyWhile(fn) {
      // Single-threaded process: just await — no real gate needed.
      return fn();
    },
    /** @param {Promise<unknown>} promise */
    waitUntil(promise) {
      Promise.resolve(promise).catch((err) =>
        console.error(`[mieweb] DO ${name} waitUntil rejected`, err),
      );
    },
    // --- WebSocket hibernation surface (non-hibernating local impl) ---
    // NOTE: serializeAttachment/deserializeAttachment are methods on the
    // WebSocket itself on Cloudflare, not on state. The WS-backed DOs
    // (AgentPresence, MeetingRoom) are therefore only best-effort locally;
    // the alarm/storage-backed DOs (SmsConversation) are fully supported.
    /** @param {any} ws @param {string[]} [_tags] */
    acceptWebSocket(ws, _tags) {
      if (typeof ws.accept === 'function') ws.accept();
      sockets.add(ws);
      ws.addEventListener?.('close', () => sockets.delete(ws));
    },
    getWebSockets() {
      return [...sockets];
    },
  };
}
