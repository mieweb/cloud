/**
 * Workers AI → local/multi-backend adapter.
 *
 * Implements the audited Workers AI subset the app uses:
 *   * `run(model, { text })` — text embeddings → `{ data: number[][] }`
 *   * `toMarkdown(documents)` — document → markdown (best-effort locally)
 *
 * The app embeds with `@cf/baai/bge-base-en-v1.5` (768-dim). Ollama's
 * `nomic-embed-text` is also 768-dim, so it's a drop-in for the local vector
 * index. The CF model id passed by the worker is mapped to the configured
 * local embedding model — the worker code stays unchanged.
 *
 * @param {object} [cfg]
 * @param {'ollama'} [cfg.backend]  embedding backend (default 'ollama')
 * @param {string} [cfg.host]  backend base URL (default http://localhost:11434)
 * @param {{ embed?: string }} [cfg.models]  local model names (embed default 'nomic-embed-text')
 * @param {typeof fetch} [cfg.fetch]  injectable fetch (for tests)
 * @returns {import('../index.mjs').LocalAi}
 */
export function createAiBackend(cfg = {}) {
  const backend = cfg.backend ?? 'ollama';
  const host = (cfg.host ?? 'http://localhost:11434').replace(/\/$/, '');
  const embedModel = cfg.models?.embed ?? 'nomic-embed-text';
  const doFetch = cfg.fetch ?? globalThis.fetch;

  if (backend !== 'ollama') {
    throw new Error(`[mieweb] unknown AI backend "${backend}" (supported: ollama)`);
  }

  /**
   * @param {string} _model  the CF model id (mapped to the local embed model)
   * @param {{ text?: string | string[] }} inputs
   */
  async function run(_model, inputs) {
    const text = inputs?.text;
    if (text == null) {
      throw new Error(`[mieweb] local AI adapter only supports embeddings (run({ text }))`);
    }
    const list = Array.isArray(text) ? text : [text];
    const data = await embedOllama(list, { host, model: embedModel, doFetch });
    return { data, shape: [data.length, data[0]?.length ?? 0] };
  }

  /**
   * Best-effort local document → markdown. Text-like blobs pass through as
   * their UTF-8 contents; binary office formats aren't converted locally, so
   * we return empty `data` (the worker treats that as "no markdown" and skips).
   * @param {Array<{ name: string, blob: Blob }>} documents
   */
  async function toMarkdown(documents) {
    const out = [];
    for (const doc of documents) {
      const type = doc.blob?.type ?? '';
      let data = '';
      if (type.startsWith('text/') || type === 'application/json') {
        try {
          data = await doc.blob.text();
        } catch {
          data = '';
        }
      }
      out.push({ name: doc.name, mimeType: type, format: 'markdown', tokens: 0, data });
    }
    return out;
  }

  return { run, toMarkdown };
}

/**
 * Embed a batch of strings via Ollama's `/api/embed` endpoint.
 * @param {string[]} texts
 * @param {{ host: string, model: string, doFetch: typeof fetch }} opts
 * @returns {Promise<number[][]>}
 */
async function embedOllama(texts, { host, model, doFetch }) {
  let res;
  try {
    res = await doFetch(`${host}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
  } catch (err) {
    throw new Error(
      `[mieweb] could not reach Ollama at ${host} (${err?.message ?? err}). ` +
        'Is `ollama serve` running and the model pulled (`ollama pull ' + model + '`)?',
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[mieweb] Ollama embed failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  // Ollama `/api/embed` returns { embeddings: number[][] }.
  const embeddings = json.embeddings ?? (json.embedding ? [json.embedding] : []);
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(
      `[mieweb] Ollama returned ${embeddings.length} embeddings for ${texts.length} inputs`,
    );
  }
  return embeddings;
}
