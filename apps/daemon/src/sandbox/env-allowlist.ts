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
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  'VOLTA_HOME',
  'COREPACK_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'CLAUDE_CODE_TMPDIR',
  'GIT_CONFIG_GLOBAL',
  'GIT_OPTIONAL_LOCKS',
  'npm_config_cache',
  'npm_config_devdir',
]);

const ALLOWED_PREFIXES = ['LC_', 'MISE_', 'pnpm_config_'] as const;

// A name that reads like a secret is denied even when its prefix or its own name is allowed.
const SECRET_LOOKING = /TOKEN|AUTH|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|COOKIE|SESSION/i;

/** Names in `env` that a sandboxed command must not inherit: everything off the allowlist. */
export function deniedEnvNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        SECRET_LOOKING.test(name) ||
        (!ALLOWED_NAMES.has(name) && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))),
    )
    .sort();
}
