/**
 * Runtime entry for `@mieweb/deploy-contract`.
 *
 * The contract is mostly types (see `index.ts`, referenced via the package's
 * `types` export condition). Only runtime *values* live at this entry so that
 * plain-`node` `.mjs` consumers can import them without a TypeScript loader.
 * Today that is {@link AuthError} and {@link RESOURCE_KINDS}; both re-export
 * from `runtime.mjs`.
 */
export { AuthError, RESOURCE_KINDS } from './runtime.mjs';
