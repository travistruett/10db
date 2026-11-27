import { APP_URL_VARIABLE } from './entities';
import { COPY_ID_VARIABLE } from './local-copy';

/** Variable names a sandboxed command inherits from the daemon's env. */
export const SANDBOX_INHERITED_ENV_NAMES: ReadonlySet<string> = new Set([
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
  'TENDB_SANDBOX',
  COPY_ID_VARIABLE,
  APP_URL_VARIABLE,
  'npm_config_cache',
  'npm_config_devdir',
  'UV_CACHE_DIR',
  'UV_TOOL_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'xcrun_db',
]);

/** Variable-name prefixes a sandboxed command inherits from the daemon's env. */
export const SANDBOX_INHERITED_ENV_PREFIXES = ['LC_', 'MISE_', 'pnpm_config_'] as const;

/** A name that reads like a secret is denied even when its prefix or its own name is allowed. */
export const SECRET_LOOKING_ENV_NAME =
  /TOKEN|AUTH|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|COOKIE|SESSION/i;

/**
 * Names the sandbox runtime sets itself (proxy, trust-store and runtime variables). A command's env is
 * applied after them, so a name here would override one.
 */
export const SANDBOX_RUNTIME_ENV_NAMES: ReadonlySet<string> = new Set([
  'SANDBOX_RUNTIME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'GIT_SSL_CAINFO',
  'AWS_CA_BUNDLE',
  'CARGO_HTTP_CAINFO',
  'DENO_CERT',
  'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE',
  'NIX_SSL_CERT_FILE',
  'SRT_SSH_PROXY_COMMAND',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_PARAMETERS',
]);

/** Name shapes the sandbox runtime sets: any proxy or CA-bundle variable, any certificate path, its own prefixes. */
const SANDBOX_RUNTIME_ENV_PATTERN = /_PROXY$|_CA_BUNDLE$|CERT|^SANDBOX_|^SRT_|^CLOUDSDK_/;

/** Whether a name is one the sandbox runtime sets, so a command's env may not use it. */
export function isSandboxRuntimeEnvName(name: string): boolean {
  return SANDBOX_RUNTIME_ENV_NAMES.has(name) || SANDBOX_RUNTIME_ENV_PATTERN.test(name);
}

/** Whether a name is one the sandbox hands a command on its own terms (inherited, secret-looking, 10db's). */
export function isSandboxManagedEnvName(name: string): boolean {
  return (
    SANDBOX_INHERITED_ENV_NAMES.has(name) ||
    SANDBOX_INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    SECRET_LOOKING_ENV_NAME.test(name) ||
    name.startsWith('TENDB_') ||
    isSandboxRuntimeEnvName(name)
  );
}
