/**
 * Config every git the daemon runs in a checkout gets, so nothing from the checkout runs as the
 * builder: no hook (a lane can write `lefthook.yml` or a directory `core.hooksPath` names) and no
 * fsmonitor program. `/dev/null` is a hooks path no hook file can be created in.
 */
export const DAEMON_GIT_CONFIG: readonly (readonly [key: string, value: string])[] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
];

/** `DAEMON_GIT_CONFIG` as `-c` arguments, which go before the git subcommand. */
export function daemonGitArgs(): string[] {
  return DAEMON_GIT_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

const COUNT = 'GIT_CONFIG_COUNT';

/**
 * `env` with `DAEMON_GIT_CONFIG` appended through `GIT_CONFIG_COUNT`, for a program such as `gh`
 * that runs git itself. Entries the environment already carries are kept, numbered before ours.
 */
export function withDaemonGitConfig(env: Readonly<Record<string, string>>): Record<string, string> {
  const given = env[COUNT];
  // git refuses a count that is not a non-negative integer, so such a value carries no entries.
  const first = given !== undefined && /^\d+$/.test(given) ? Number(given) : 0;
  const out: Record<string, string> = { ...env };
  DAEMON_GIT_CONFIG.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${String(first + i)}`] = key;
    out[`GIT_CONFIG_VALUE_${String(first + i)}`] = value;
  });
  out[COUNT] = String(first + DAEMON_GIT_CONFIG.length);
  return out;
}
