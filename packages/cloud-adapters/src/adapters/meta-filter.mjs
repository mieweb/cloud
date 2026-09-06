/**
 * Vectorize-style metadata filtering, shared by every vector adapter
 * (sqlite-vec locally, libSQL on os, future backends). Keeping it here means
 * each adapter only handles vector storage/KNN; filter semantics stay
 * identical across targets.
 *
 * Supports implicit equality and `$eq/$ne/$in/$nin/$lt/$lte/$gt/$gte`.
 *
 * @param {Record<string, any>} metadata
 * @param {Record<string, any>} filter
 * @returns {boolean}
 */
export function matchesFilter(metadata, filter) {
  for (const [field, cond] of Object.entries(filter)) {
    const value = metadata[field];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (!applyOp(op, value, operand)) return false;
      }
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

/**
 * @param {string} op
 * @param {any} value
 * @param {any} operand
 */
export function applyOp(op, value, operand) {
  switch (op) {
    case '$eq':
      return value === operand;
    case '$ne':
      return value !== operand;
    case '$in':
      return Array.isArray(operand) && operand.includes(value);
    case '$nin':
      return Array.isArray(operand) && !operand.includes(value);
    case '$lt':
      return value < operand;
    case '$lte':
      return value <= operand;
    case '$gt':
      return value > operand;
    case '$gte':
      return value >= operand;
    default:
      // Unknown operator → don't match (fail closed).
      return false;
  }
}
