/**
 * Runtime values for `@mieweb/deploy-contract`.
 *
 * The contract is overwhelmingly *types* (see `index.ts` / `index.d.ts`), but a
 * couple of things must exist at runtime — chiefly {@link AuthError}, which
 * providers `throw` and the CLI catches with `instanceof`. Those live here in
 * plain ESM so a provider written as bare-`node` `.mjs` (like
 * `@mieweb/deploy-wrangler`) can `import` them without any TypeScript loader or
 * build step. `index.d.ts` re-exports these declarations so TS consumers still
 * see one surface.
 */

/**
 * Thrown by a provider when a verb cannot proceed because the caller is not
 * authenticated (or the credentials are expired/insufficient). The
 * control-plane analogue of `UnsupportedBindingError` on the data plane: the
 * CLI catches it and prints an actionable hint (e.g. "run `mieweb login`")
 * instead of a generic failure.
 *
 * Providers should throw this — rather than a bare `Error` — for any 401/403
 * from their backend, so the CLI can distinguish "not logged in" from "the
 * deploy genuinely failed."
 */
export class AuthError extends Error {
  /**
   * @param {string} provider the provider that raised it (`provider.name`)
   * @param {string} target the target being acted on, for message context
   * @param {string} [hint] optional actionable hint the CLI surfaces verbatim
   */
  constructor(provider, target, hint) {
    super(
      `Not authenticated for provider "${provider}" on target "${target}"${
        hint ? `: ${hint}` : '.'
      }`,
    );
    this.name = 'AuthError';
    /** @type {string} */
    this.provider = provider;
    /** @type {string} */
    this.target = target;
    /** @type {string|undefined} */
    this.hint = hint;
  }
}

/**
 * The canonical, closed set of neutral resource kinds a `ResourceHandle` may
 * declare. This is the **single source of truth**: the `ResourceKind` type in
 * `index.ts` is derived from this array (`typeof RESOURCE_KINDS[number]`), and
 * the conformance test-kit validates against it — so adding a kind here updates
 * both the type and the runtime check at once.
 * @type {readonly ['database','bucket','kv','queue','vector','stateful','ai','container']}
 */
export const RESOURCE_KINDS = /** @type {const} */ ([
  'database',
  'bucket',
  'kv',
  'queue',
  'vector',
  'stateful',
  'ai',
  'container',
]);
