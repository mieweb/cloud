/**
 * Minimal JSONC reader shared by the mieweb CLI.
 *
 * wrangler.jsonc (and mieweb.jsonc) use comments and trailing commas, which
 * `JSON.parse` rejects. Rather than pull in a dependency (and to keep the CLI
 * runnable with bare `node`), we strip comments + trailing commas in a
 * string-aware single pass, then hand the result to `JSON.parse`.
 *
 * This is deliberately small: it understands `//` line comments, `/​* *​/`
 * block comments, double-quoted strings with escapes, and trailing commas
 * before `}`/`]`. That covers everything wrangler emits.
 *
 * @param {string} text raw JSONC source
 * @returns {unknown} parsed value
 */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Copy the escaped character verbatim.
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      // Line comment: skip to end of line.
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment: skip to closing */.
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Remove trailing commas (`,]` / `,}`), tolerating whitespace between.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}
