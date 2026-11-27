import {
  SANDBOX_INHERITED_ENV_NAMES,
  SANDBOX_INHERITED_ENV_PREFIXES,
  SECRET_LOOKING_ENV_NAME,
} from '@10db/contracts';

const ALLOWED_NAMES = SANDBOX_INHERITED_ENV_NAMES;
const ALLOWED_PREFIXES = SANDBOX_INHERITED_ENV_PREFIXES;

/** Whether a variable name reads like a secret, which a sandboxed command never inherits. */
export function looksSecret(name: string): boolean {
  return SECRET_LOOKING_ENV_NAME.test(name);
}

/** Whether a name is one a sandboxed command inherits from the daemon's env. */
export function isAllowlistedName(name: string): boolean {
  return ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Names in `env` that a sandboxed command must not inherit: everything off the allowlist. `also`
 * names more that the caller allows for this command (a project with Docker on adds `DOCKER_HOST`);
 * a name that reads like a secret is denied whatever `also` says.
 */
export function deniedEnvNames(
  env: Readonly<Record<string, string>>,
  also: ReadonlySet<string> = NO_NAMES,
): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        looksSecret(name) ||
        (!ALLOWED_NAMES.has(name) &&
          !also.has(name) &&
          !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))),
    )
    .sort();
}

const NO_NAMES: ReadonlySet<string> = new Set();
