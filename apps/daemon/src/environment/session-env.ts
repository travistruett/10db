import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { BillingMode } from '@10db/contracts';

/** Variables that silently change who is billed. They are removed unless the billing mode needs them. */
export const BILLING_SWITCH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;
/**
 * Whole families of provider switches, so a provider added in a later Claude Code release is stripped too.
 * `CLAUDE_CODE_USE_*` also catches non-billing toggles; none of them matter to a managed session on macOS.
 */
const BILLING_SWITCH_PREFIXES = [
  'ANTHROPIC_DEFAULT_',
  'CLAUDE_CODE_USE_',
  'ANTHROPIC_VERTEX_',
  'ANTHROPIC_FOUNDRY_',
] as const;
/** Kept in Bedrock mode only: Bedrock's own credentials and endpoint. */
const BEDROCK_KEEPS: readonly string[] = ['AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL'];

/** Set inside a Claude Code session; a managed session started from one must not inherit them. */
export const NESTED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PROJECT_DIR',
] as const;

const OWN_PREFIX = 'TENDB_';
const CLIENT_APP_VAR = 'CLAUDE_AGENT_SDK_CLIENT_APP';
const KEYCHAIN_TIMEOUT_MS = 5_000;

const KEYCHAIN = { service: '10db', apiKeyAccount: 'anthropic-api-key' } as const;

export interface SecretSource {
  anthropicApiKey(): string | null;
}

/** `security` exits with this status when the Keychain has no such item. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

type KeychainExec = (
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

/**
 * Builds a Keychain reader over `exec`. Only "item not found" means there is no key; a timeout,
 * a locked or unreachable Keychain or a denied prompt throws, because telling the builder to add
 * a key that exists would send them the wrong way. Messages carry the status, never the output.
 */
export function keychainSecretsWith(exec: KeychainExec): SecretSource {
  return {
    anthropicApiKey() {
      try {
        const value = exec(
          '/usr/bin/security',
          ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.apiKeyAccount, '-w'],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: KEYCHAIN_TIMEOUT_MS,
          },
        ).trim();
        return value.length > 0 ? value : null;
      } catch (error) {
        const failure = error as { status?: number | null; code?: string; signal?: string | null };
        if (failure.status === KEYCHAIN_ITEM_NOT_FOUND) return null;
        if (failure.code === 'ETIMEDOUT')
          throw new SessionEnvError(
            `Reading the API key from the Keychain timed out after ${String(KEYCHAIN_TIMEOUT_MS / 1000)} s`,
          );
        if (typeof failure.status === 'number')
          throw new SessionEnvError(
            `Reading the API key from the Keychain failed (security exit status ${String(failure.status)})`,
          );
        throw new SessionEnvError(
          `Reading the API key from the Keychain failed (${failure.code ?? failure.signal ?? 'unknown error'})`,
        );
      }
    },
  };
}

/**
 * Reads the API key from the login Keychain when a session starts; nothing is cached.
 */
export const keychainSecrets: SecretSource = keychainSecretsWith(execFileSync);

/** The session environment can't be built for this billing mode. The message says what to fix. */
export class SessionEnvError extends Error {
  override readonly name = 'SessionEnvError';
}

const SWITCHES: readonly string[] = BILLING_SWITCH_VARS;
const NESTED: readonly string[] = NESTED_SESSION_VARS;

/** Whether `name` is a billing-switch variable or belongs to a provider-switch family. */
export function isBillingSwitch(name: string): boolean {
  return (
    SWITCHES.includes(name) || BILLING_SWITCH_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * One session's environment: the captured login environment, minus anything that would change
 * billing or confuse a nested Claude Code, plus what the project's billing mode requires.
 * It only prevents accidental switches; every supported auth method still works when chosen.
 */
export function buildSessionEnv(input: {
  readonly base: Readonly<Record<string, string>>;
  readonly billingMode: BillingMode;
  readonly clientApp: string;
  readonly secrets: SecretSource;
}): Record<string, string> {
  const keep = (name: string): boolean => {
    if (name.startsWith(OWN_PREFIX) || NESTED.includes(name)) return false;
    if (!isBillingSwitch(name)) return true;
    return input.billingMode === BillingMode.Bedrock && BEDROCK_KEEPS.includes(name);
  };
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(input.base).filter(([name]) => keep(name)),
  );
  env[CLIENT_APP_VAR] = input.clientApp;

  switch (input.billingMode) {
    case BillingMode.Subscription:
      break;
    case BillingMode.ApiKey: {
      const key = input.secrets.anthropicApiKey();
      if (!key) {
        throw new SessionEnvError(
          `No Anthropic API key in the Keychain. Add it with: security add-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.apiKeyAccount} -w`,
        );
      }
      env['ANTHROPIC_API_KEY'] = key;
      break;
    }
    case BillingMode.Bedrock:
      if (!env['AWS_REGION'] && !env['AWS_DEFAULT_REGION'])
        throw new SessionEnvError('Bedrock billing needs AWS_REGION in your login shell');
      env['CLAUDE_CODE_USE_BEDROCK'] = '1';
      break;
  }
  return env;
}

/** The billing mode an environment built by `buildSessionEnv` selects. */
export function inferBillingMode(env: Readonly<Record<string, string>>): BillingMode {
  if (env['CLAUDE_CODE_USE_BEDROCK']) return BillingMode.Bedrock;
  if (env['ANTHROPIC_API_KEY']) return BillingMode.ApiKey;
  return BillingMode.Subscription;
}
