const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TZ',
  'TMPDIR',
  'PNPM_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'CLAUDE_CODE_TMPDIR',
  'GIT_CONFIG_GLOBAL',
  'npm_config_cache',
]);

const ALLOWED_PREFIXES = ['LC_', 'MISE_', 'pnpm_config_'] as const;

/** Names in `env` that a sandboxed command must not inherit: everything off the allowlist. */
export function deniedEnvNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        !ALLOWED_NAMES.has(name) && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .sort();
}
