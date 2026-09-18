/**
 * Parse JSONC (JSON with comments and trailing commas) into a value.
 * String-aware: string contents are never rewritten.
 */
export function parseJsonc(text: string): unknown;
