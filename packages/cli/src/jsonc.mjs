// @ts-check
import { parse, printParseErrorCode } from 'jsonc-parser';

/**
 * Parse JSONC (comments + trailing commas, as in wrangler.jsonc/mieweb.jsonc).
 * Throws a SyntaxError on malformed input instead of returning a partial value.
 *
 * @param {string} text
 * @param {string} [file] for the error message
 * @returns {unknown}
 */
export function parseJsonc(text, file = 'JSONC') {
  /** @type {import('jsonc-parser').ParseError[]} */
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split('\n').length;
    throw new SyntaxError(`${file}:${line}: ${printParseErrorCode(e.error)}`);
  }
  return value;
}
