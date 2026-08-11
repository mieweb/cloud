/**
 * Environment variable naming for agent CLIs.
 *
 * Each agent reads from its own namespace derived from its name, so several
 * agents can coexist in one shell without colliding. `AGENT_*` is the shared
 * fallback for the generic dispatcher and for agents whose name does not
 * produce a usable prefix.
 */

const FALLBACK_PREFIX = "AGENT";

/**
 * Derive the environment variable prefix for an agent name.
 * `"assistant"` yields `"ASSISTANT"`, `"my-agent"` yields `"MY_AGENT"`.
 */
export function envPrefix(agent?: string): string {
  const normalized = (agent ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || FALLBACK_PREFIX;
}

/**
 * Read an agent-scoped variable, falling back to the shared `AGENT_*` name.
 */
export function readEnv(
  agent: string | undefined,
  suffix: string
): string | undefined {
  const prefix = envPrefix(agent);
  if (prefix !== FALLBACK_PREFIX) {
    const scoped = process.env[`${prefix}_${suffix}`];
    if (scoped) return scoped;
  }
  return process.env[`${FALLBACK_PREFIX}_${suffix}`];
}
