/**
 * Minimal JSONC reader shared by @mieweb tooling (CLI + deploy providers).
 *
 * wrangler.jsonc (and mieweb.jsonc) use comments and trailing commas, which
 * `JSON.parse` rejects. Rather than pull in a dependency (and to keep the
 * provider runnable with bare `node`), we strip comments + trailing commas in a
 * single string-aware pass, then hand the result to `JSON.parse`.
 *
 * This is deliberately small: it understands `//` line comments, block
 * comments, double-quoted strings with escapes, and trailing commas before
 * `}`/`]`. Crucially the trailing-comma removal happens *inside* the scan — only
 * when outside a string — so a string value that legitimately contains `,}` or
 * `,]` (e.g. `"value,}"`) is never rewritten.
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
      // Line comment: replace with a newline so tokens on either side stay
      // separated, then skip to end of line.
      out += '\n';
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment: emit a single space in its place so token-separated text
      // like `1/*x*/2` does not collapse into `12`, then skip to the closing */.
      // An unterminated block comment is a syntax error.
      out += ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      if (i >= n) throw new SyntaxError('parseJsonc: unterminated block comment');
      i += 2;
      continue;
    }

    if (ch === ',') {
      // Trailing comma? Look ahead past whitespace and comments (outside any
      // string) to the next significant character; if it closes a container,
      // drop this comma. Otherwise emit it. This runs only here — never over
      // string contents — so `"a,}"` is preserved intact.
      if (isTrailingComma(text, i + 1)) {
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return JSON.parse(out);
}

/**
 * From index `j`, skip whitespace and comments and report whether the next
 * significant character closes an object/array (`}`/`]`) — i.e. the comma at
 * `j-1` is a trailing comma.
 * @param {string} text
 * @param {number} j
 * @returns {boolean}
 */
function isTrailingComma(text, j) {
  const n = text.length;
  let i = j;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    return ch === '}' || ch === ']';
  }
  return false;
}
