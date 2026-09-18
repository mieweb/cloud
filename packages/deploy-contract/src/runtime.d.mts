import type { DeployTarget } from './index.js';

/**
 * Thrown by a provider when a verb cannot proceed because the caller is not
 * authenticated. See the runtime implementation in `runtime.mjs`.
 */
export class AuthError extends Error {
  readonly provider: string;
  readonly target: DeployTarget;
  readonly hint?: string;
  constructor(provider: string, target: DeployTarget, hint?: string);
}

/**
 * The canonical closed set of neutral resource kinds. Single source of truth for
 * both the `ResourceKind` type (derived in `index.ts`) and the test-kit's
 * runtime validation.
 */
export const RESOURCE_KINDS: readonly [
  'database',
  'bucket',
  'kv',
  'queue',
  'vector',
  'stateful',
  'ai',
  'container',
];
