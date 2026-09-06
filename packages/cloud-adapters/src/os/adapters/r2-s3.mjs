/**
 * R2 → S3-compatible object storage adapter (os.mieweb.org target).
 *
 * Targets one bucket on any S3 API (MinIO, SeaweedFS, AWS S3). Implements the
 * audited R2 subset — `put(key, value, opts)`, `get(key, { range })`,
 * `head(key)`, `delete(key)`, `list({ prefix })` — and reconstructs the same
 * R2Object/R2ObjectBody shape the worker (and the local `fs` adapter) expect,
 * including `httpMetadata.contentType`, `customMetadata`, and the body
 * accessors (`arrayBuffer/text/json/blob/body`).
 *
 * Construction is async (ensures the bucket exists); `settleEnv` awaits it.
 *
 * @param {{
 *   endpoint?: string, region?: string, bucket: string,
 *   accessKeyId?: string, secretAccessKey?: string,
 *   forcePathStyle?: boolean, createIfMissing?: boolean
 * }} cfg
 * @returns {Promise<import('@mieweb/cloud-local').LocalBucket>}
 */
export async function createS3Bucket(cfg) {
  const s3 = await loadS3();
  const {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    CreateBucketCommand,
    HeadBucketCommand,
  } = s3;

  const Bucket = cfg.bucket;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? 'us-east-1',
    forcePathStyle: cfg.forcePathStyle ?? true,
    credentials:
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
        : undefined,
  });

  if (cfg.createIfMissing !== false) {
    try {
      await client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      try {
        await client.send(new CreateBucketCommand({ Bucket }));
      } catch (err) {
        // Another process may have created it concurrently; ignore.
        if (!String(err?.name).match(/BucketAlreadyOwnedByYou|BucketAlreadyExists/)) {
          // Surface only genuinely unexpected failures.
          if (err?.$metadata?.httpStatusCode !== 409) throw err;
        }
      }
    }
  }

  /**
   * @param {string} key
   * @param {Buffer} buf
   * @param {{ contentType?: string, customMetadata?: Record<string, string>, etag?: string, uploaded?: Date }} info
   * @param {boolean} withBody
   */
  function toObject(key, buf, info, withBody) {
    const etag = info.etag ?? `"${buf.length.toString(16)}"`;
    const base = {
      key,
      size: buf.length,
      etag,
      httpEtag: etag,
      uploaded: info.uploaded ?? new Date(),
      httpMetadata: info.contentType ? { contentType: info.contentType } : {},
      customMetadata: info.customMetadata ?? {},
      /** @param {Headers} headers */
      writeHttpMetadata(headers) {
        if (info.contentType) headers.set('content-type', info.contentType);
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
      const Range = rangeHeader(opts?.range);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key, Range }));
        const buf = await streamToBuffer(res.Body);
        return toObject(
          key,
          buf,
          {
            contentType: res.ContentType,
            customMetadata: res.Metadata,
            etag: res.ETag,
            uploaded: res.LastModified,
          },
          true,
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    /** @param {string} key */
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        const size = Number(res.ContentLength ?? 0);
        return toObject(
          key,
          Buffer.alloc(size),
          {
            contentType: res.ContentType,
            customMetadata: res.Metadata,
            etag: res.ETag,
            uploaded: res.LastModified,
          },
          false,
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    /**
     * @param {string} key
     * @param {ArrayBuffer|ArrayBufferView|string|ReadableStream|Blob} value
     * @param {{ httpMetadata?: Record<string, string>, customMetadata?: Record<string, string> }} [opts]
     */
    async put(key, value, opts) {
      const buf = await toBuffer(value);
      const contentType = opts?.httpMetadata?.contentType;
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: buf,
          ContentType: contentType,
          Metadata: opts?.customMetadata,
        }),
      );
      return toObject(key, buf, { contentType, customMetadata: opts?.customMetadata }, false);
    },

    /** @param {string} key */
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    /** @param {{ prefix?: string }} [opts] */
    async list(opts) {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix: opts?.prefix ?? undefined }),
      );
      const objects = (res.Contents ?? []).map((o) =>
        toObject(o.Key, Buffer.alloc(Number(o.Size ?? 0)), {
          etag: o.ETag,
          uploaded: o.LastModified,
        }, false),
      );
      return { objects, truncated: Boolean(res.IsTruncated), delimitedPrefixes: [] };
    },
  };
}

/** @param {{ offset?: number, length?: number }} [range] */
function rangeHeader(range) {
  if (!range || typeof range.offset !== 'number') return undefined;
  const start = range.offset;
  if (typeof range.length === 'number') return `bytes=${start}-${start + range.length - 1}`;
  return `bytes=${start}-`;
}

/** @param {any} err */
function isNotFound(err) {
  const code = err?.$metadata?.httpStatusCode;
  return code === 404 || err?.name === 'NoSuchKey' || err?.name === 'NotFound';
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

/** Read an AWS SDK v3 stream / web stream / Node Readable fully into a Buffer. */
async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  // AWS SDK v3 attaches transformToByteArray on Node/browser streams.
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body instanceof ReadableStream || typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  // Node Readable.
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** @param {ArrayBuffer|ArrayBufferView|string|ReadableStream|Blob} value */
async function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  if (value instanceof ReadableStream) return streamToBuffer(value);
  throw new TypeError('Unsupported R2 put() value type');
}

async function loadS3() {
  try {
    return await import('@aws-sdk/client-s3');
  } catch {
    throw new Error(
      "The os R2 adapter needs '@aws-sdk/client-s3'. Install it with " +
        '`pnpm add @aws-sdk/client-s3` (or choose a different bucket driver).',
    );
  }
}
