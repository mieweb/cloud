/**
 * @mieweb/cloud-os — adapters for the `mieweb` (os.mieweb.org) target.
 *
 * These implement the same Cloudflare-shaped @mieweb/cloud contracts as the
 * local adapters, but over durable, networked infrastructure:
 *
 *   | Binding   | Driver          | Backend                       |
 *   | --------- | --------------- | ----------------------------- |
 *   | D1        | `libsql`        | libSQL/sqld (SQLite + FTS5)    |
 *   | Vectorize | `libsql-vec`    | libSQL native vectors         |
 *   | R2        | `s3`            | S3-compatible (MinIO/S3)       |
 *   | KV        | `valkey`        | Valkey/Redis                  |
 *   | Queues    | `valkey-queue`  | Valkey/Redis (list + zset)    |
 *   | AI        | `ai`            | reused from @mieweb/cloud-local (Ollama) |
 *   | DO        | `inproc`        | reused — single-node best-effort |
 *
 * Drivers register into the shared registry from @mieweb/cloud-local, so
 * `createCloudEnv` dispatches `mieweb`-target bindings to them with no core
 * changes. Importing this module is enough to register them; `register()` is
 * exported for explicitness and is idempotent.
 */

import { registerDriver } from '@mieweb/cloud-local';
import { createLibsqlD1 } from './adapters/d1-libsql.mjs';
import { createLibsqlVecIndex } from './adapters/vectorize-libsql.mjs';
import { createS3Bucket } from './adapters/r2-s3.mjs';
import { createValkeyKV } from './adapters/kv-valkey.mjs';
import { createValkeyQueue } from './adapters/queue-valkey.mjs';

export { createLibsqlD1 } from './adapters/d1-libsql.mjs';
export { createLibsqlVecIndex } from './adapters/vectorize-libsql.mjs';
export { createS3Bucket } from './adapters/r2-s3.mjs';
export { createValkeyKV } from './adapters/kv-valkey.mjs';
export { createValkeyQueue } from './adapters/queue-valkey.mjs';

let registered = false;

/** Register the os drivers into the @mieweb/cloud-local registry (idempotent). */
export function register() {
  if (registered) return;
  registered = true;

  registerDriver('libsql', ({ cfg }) =>
    createLibsqlD1({ url: cfg.url, authToken: cfg.authToken }),
  );

  registerDriver('libsql-vec', ({ cfg }) =>
    createLibsqlVecIndex({
      url: cfg.url,
      authToken: cfg.authToken,
      dim: cfg.dim ?? 768,
      table: cfg.table,
    }),
  );

  registerDriver('s3', ({ cfg }) =>
    createS3Bucket({
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      forcePathStyle: cfg.forcePathStyle,
      createIfMissing: cfg.createIfMissing,
    }),
  );

  registerDriver('valkey', ({ cfg }) =>
    createValkeyKV({ url: cfg.url, host: cfg.host, port: cfg.port, namespace: cfg.namespace }),
  );

  registerDriver('valkey-queue', ({ cfg, getQueueConsumer, getEnv }) =>
    createValkeyQueue(cfg.queue, getQueueConsumer, getEnv, {
      url: cfg.url,
      host: cfg.host,
      port: cfg.port,
      namespace: cfg.namespace,
      batchSize: cfg.batchSize,
      pollMs: cfg.pollMs,
    }),
  );
}

// Register on import for convenience.
register();
