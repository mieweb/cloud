/**
 * Stand-in for a binding the active target cannot emulate (e.g. Vectorize or
 * Workers AI outside Cloudflare). Every property access returns a function
 * that throws `UnsupportedBindingError`, so the failure is loud and points at
 * the exact binding + target. Callers that can degrade (search → FTS-only)
 * already guard on the binding being present/working and catch this.
 *
 * @param {string} bindingName e.g. 'SEARCH_INDEX'
 * @param {string} target e.g. 'local'
 * @returns {any} a proxy that throws on use
 */
export function createUnsupportedBinding(bindingName, target) {
  const fail = () => {
    const err = new Error(
      `Binding "${bindingName}" is not supported on target "${target}".`,
    );
    err.name = 'UnsupportedBindingError';
    throw err;
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Must not look like a thenable: `settleEnv` (and any Promise.resolve)
        // duck-types `.then`, and returning `fail` here would throw at env-build
        // time instead of at the call site. Stay inert until actually used.
        if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
        if (typeof prop === 'symbol') return undefined;
        return fail;
      },
      apply() {
        return fail();
      },
    },
  );
}
