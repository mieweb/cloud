import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * R2 → filesystem-backed object storage adapter.
 *
 * Implements the audited R2 subset: `put(key, value, opts)`,
 * `get(key, opts)` (including `range` reads used for audio streaming),
 * `head(key)`, `delete(key)`, and a basic `list({ prefix })`. Objects are
 * stored as `<root>/<key>` with a sibling `<key>.meta.json` holding
 * httpMetadata + customMetadata so `get()` can reconstruct an R2Object.
 *
 * Keys may contain `/`; intermediate directories are created on write.
 *
 * @param {string} root directory that backs this bucket
 * @returns {import('../index.mjs').LocalBucket}
 */
export function createFsBucket(root) {
  mkdirSync(root, { recursive: true });

  /** @param {string} key */
  const objPath = (key) => join(root, key);
  /** @param {string} key */
  const metaPath = (key) => join(root, `${key}.__meta.json`);

  /** @param {string} key */
  function readMeta(key) {
    try {
      return JSON.parse(readFileSync(metaPath(key), 'utf8'));
    } catch {
      return { httpMetadata: {}, customMetadata: {} };
    }
  }

  /**
   * Build an R2Object/R2ObjectBody-compatible wrapper over a Buffer.
   * @param {string} key
   * @param {Buffer} buf
   * @param {boolean} withBody
   */
  function toObject(key, buf, withBody) {
    const meta = readMeta(key);
    const base = {
      key,
      size: buf.length,
      etag: `"${buf.length.toString(16)}"`,
      httpEtag: `"${buf.length.toString(16)}"`,
      uploaded: existsSync(objPath(key)) ? statSync(objPath(key)).mtime : new Date(),
      httpMetadata: meta.httpMetadata ?? {},
      customMetadata: meta.customMetadata ?? {},
      /** @param {Headers} headers */
      writeHttpMetadata(headers) {
        const ct = meta.httpMetadata?.contentType;
        if (ct) headers.set('content-type', ct);
      },
    };
    if (!withBody) return base;
    return {
      ...base,
      body: bufferToReadableStream(buf),
      bodyUsed: false,
      async arrayBuffer() {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      async text() {
        return buf.toString('utf8');
      },
      async json() {
        return JSON.parse(buf.toString('utf8'));
      },
      async blob() {
        return new Blob([buf]);
      },
    };
  }

  return {
    /**
     * @param {string} key
     * @param {{ range?: { offset?: number, length?: number } }} [opts]
     */
    async get(key, opts) {
      const p = objPath(key);
      if (!existsSync(p) || statSync(p).isDirectory()) return null;
      let buf = readFileSync(p);
      const range = opts?.range;
      if (range && typeof range.offset === 'number') {
        const start = range.offset;
        const end =
          typeof range.length === 'number' ? start + range.length : buf.length;
        buf = buf.subarray(start, end);
      }
      return toObject(key, buf, true);
    },

    /** @param {string} key */
    async head(key) {
      const p = objPath(key);
      if (!existsSync(p) || statSync(p).isDirectory()) return null;
      return toObject(key, readFileSync(p), false);
    },

    /**
     * @param {string} key
     * @param {ArrayBuffer|ArrayBufferView|string|ReadableStream|Blob} value
     * @param {{ httpMetadata?: Record<string, string>, customMetadata?: Record<string, string> }} [opts]
     */
    async put(key, value, opts) {
      const p = objPath(key);
      mkdirSync(dirname(p), { recursive: true });
      const buf = await toBuffer(value);
      writeFileSync(p, buf);
      writeFileSync(
        metaPath(key),
        JSON.stringify({
          httpMetadata: opts?.httpMetadata ?? {},
          customMetadata: opts?.customMetadata ?? {},
        }),
      );
      return toObject(key, buf, false);
    },

    /** @param {string} key */
    async delete(key) {
      rmSync(objPath(key), { force: true });
      rmSync(metaPath(key), { force: true });
    },

    /** @param {{ prefix?: string }} [opts] */
    async list(opts) {
      const prefix = opts?.prefix ?? '';
      const objects = [];
      for (const key of walk(root, root)) {
        if (key.endsWith('.__meta.json')) continue;
        if (!key.startsWith(prefix)) continue;
        objects.push(toObject(key, readFileSync(objPath(key)), false));
      }
      return { objects, truncated: false, delimitedPrefixes: [] };
    },
  };
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {string[]} relative keys
 */
function walk(dir, root) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, root));
    else out.push(full.slice(root.length + 1));
  }
  return out;
}

/** @param {Buffer} buf */
function bufferToReadableStream(buf) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

/** @param {ArrayBuffer|ArrayBufferView|string|ReadableStream|Blob} value */
async function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError('Unsupported R2 put() value type');
}
