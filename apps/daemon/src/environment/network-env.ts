import { NESTED_SESSION_VARS } from './session-env';

const OWN_PREFIX = 'TENDB_';
const NESTED: readonly string[] = NESTED_SESSION_VARS;

/**
 * The environment fetch, push and gh run in: the builder's login environment, which holds their
 * git credentials, SSH agent and gh token, minus 10db's own and nested-session variables. The git
 * and github modules turn prompts off on top of it. It holds secrets: memory only, never logged.
 */
export function buildNetworkEnv(base: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter(([name]) => !name.startsWith(OWN_PREFIX) && !NESTED.includes(name)),
  );
}
