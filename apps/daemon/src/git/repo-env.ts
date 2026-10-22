/**
 * The variables that point git at a particular repository: `git rev-parse --local-env-vars`
 * without its three config variables. Git exports several to its hooks, so a process started
 * from a hook (or a git alias) carries them, and any git it runs with them acts on that
 * repository instead of the one it was pointed at with `-C` or a cwd.
 *
 * `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT` (with its `GIT_CONFIG_KEY_n` and
 * `GIT_CONFIG_VALUE_n`) are kept: they carry config, such as a profile's url rewrite, and name
 * no repository.
 */
export const GIT_REPO_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const;

const REPO_VARS: readonly string[] = GIT_REPO_ENV_VARS;

/** `env` without the repository variables; every other variable, git config included, is kept. */
export function withoutGitRepoEnv<T>(env: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !REPO_VARS.includes(name)));
}
