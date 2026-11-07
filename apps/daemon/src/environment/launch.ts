import {
  AccountKind,
  AccountProblem,
  ApiKeySettings,
  BedrockSettings,
  GatewaySettings,
  isModelTier,
  Provider,
  providerOf,
  SubscriptionSettings,
  type AccountId,
  type AccountModelDto,
  type SupportedAccountKind,
} from '@10db/contracts';
import { isAbsolute, join } from 'node:path';
import type { AccountRow } from '@10db/db';
import { secretFingerprint, type Keychain } from './keychain';
import { stripBillingSwitches } from './session-env';

/** The Claude Code version the account variables and `accountInfo()` fields were verified on (spike 12). */
export const ACCOUNT_NAMES_VERIFIED_ON = '2.1.302';

/** A Bedrock session takes its AWS credentials from its account only, never from the login shell. */
const AWS_LOGIN_VARS: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
];
/** A ChatGPT sign-in session takes its credential from its own CODEX_HOME only, never from the login shell. */
const CODEX_LOGIN_VARS: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_ACCESS_TOKEN',
  'CODEX_HOME',
];
const CLIENT_APP_VAR = 'CLAUDE_AGENT_SDK_CLIENT_APP';

/** What a session on an account must report before its prompt (accounts spec §5). */
export interface AccountExpectation {
  readonly accountId: AccountId;
  readonly label: string;
  readonly kind: SupportedAccountKind;
  /** The email (subscription) or organization (keyed) Claude Code must report; null compares none. */
  readonly identity: string | null;
}

export interface SessionLaunch {
  readonly env: Readonly<Record<string, string>>;
  /** What the CLI is launched with: the account's own ID for the model, or the canonical ID when it lists none. */
  readonly model: string;
  readonly expect: AccountExpectation;
}

interface ProbeLaunch {
  readonly env: Readonly<Record<string, string>>;
  readonly expect: AccountExpectation;
}

/** The account can't start a session as it stands; the message names the account, never a value. */
export class AccountLaunchError extends Error {
  override readonly name = 'AccountLaunchError';
  readonly accountId: AccountId;
  readonly problem: AccountProblem;
  constructor(accountId: AccountId, problem: AccountProblem, message: string) {
    super(message);
    this.accountId = accountId;
    this.problem = problem;
  }
}

/** A step named a tier, not a model: its account offered nothing to run, so there is nothing to launch. */
export class ModelNotLaunchableError extends Error {
  override readonly name = 'ModelNotLaunchableError';
  readonly model: string;
  constructor(model: string) {
    super(`"${model}" names a model tier, not a model, so there is nothing to launch`);
    this.model = model;
  }
}

/** The one owner of account variables (accounts spec §3). */
export interface Launcher {
  /** The login env with every billing switch stripped: for the gate and the repo's MCP servers. */
  projectEnv(): Record<string, string>;
  /**
   * A session on `account` running `model` (a canonical ID); `accountModels` is that account's own list: it launches the account's `launchId` for the
   * model, or the canonical ID when the account lists none. Reads a keyed account's secret now and caches
   * nothing. Throws `ModelNotLaunchableError` for a tier name.
   */
  session(
    account: AccountRow,
    model: string,
    accountModels: readonly AccountModelDto[],
  ): SessionLaunch;
  /** The same environment, for reading who the account is without a prompt. */
  probe(account: AccountRow): ProbeLaunch;
  /** Where the builder's own login lives when the login shell moves it: an absolute directory, or null for Claude Code's default. */
  loginConfigDir(): string | null;
  /** Why the login shell's directory was ignored (it is relative), naming the variable and never its value; null otherwise. */
  loginConfigDirWarning(): string | null;
  /**
   * Where the login shell keeps a personal ChatGPT login when it moves `CODEX_HOME` off `~/.codex`: an
   * absolute directory, or null. No session runs on it; every sandbox denies it, as it does `~/.codex`.
   */
  loginCodexHome(): string | null;
}

function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Signs a subscription in with the unmodified `claude`, unsetting any exported directory for the default account; the path is one shell word even with spaces. */
export function signInCommand(configDir: string | null): string {
  return configDir === null
    ? 'env -u CLAUDE_CONFIG_DIR claude /login'
    : `CLAUDE_CONFIG_DIR=${quoted(configDir)} claude /login`;
}

/** Signs a ChatGPT plan in with the unmodified `codex`; the path is one shell word even with spaces. */
export function codexSignInCommand(home: string): string {
  return `CODEX_HOME=${quoted(home)} codex login`;
}

/** The sign-in command of an account that signs in with a login. */
export function signInCommandFor(account: {
  readonly kind: SupportedAccountKind;
  readonly configDir: string | null;
}): string {
  if (account.kind !== AccountKind.CodexSignin) return signInCommand(account.configDir);
  return account.configDir === null
    ? 'env -u CODEX_HOME codex login'
    : codexSignInCommand(account.configDir);
}

/**
 * The directory a session's agent keeps its login in: CODEX_HOME for a Codex kind (default `~/.codex`),
 * CLAUDE_CONFIG_DIR for a Claude kind (default `~/.claude`). A Claude kind ignores CODEX_HOME.
 */
export function sessionConfigDir(
  kind: SupportedAccountKind,
  env: Readonly<Record<string, string>>,
  home: string,
): string {
  return providerOf(kind) === Provider.Codex
    ? (env['CODEX_HOME'] ?? join(home, '.codex'))
    : (env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'));
}

/** The login env minus what the kind takes from its account only. */
function withoutVars(
  login: Readonly<Record<string, string>>,
  kind: SupportedAccountKind,
): Record<string, string> {
  const dropped =
    kind === AccountKind.Bedrock
      ? AWS_LOGIN_VARS
      : kind === AccountKind.CodexSignin
        ? CODEX_LOGIN_VARS
        : [];
  return Object.fromEntries(Object.entries(login).filter(([name]) => !dropped.includes(name)));
}

export function createLauncher(opts: {
  readonly base: Readonly<Record<string, string>>;
  readonly clientApp: string;
  readonly keychain: Keychain;
}): Launcher {
  const projectEnv = (): Record<string, string> => stripBillingSwitches(opts.base);

  function secretOf(account: AccountRow): string {
    const missing = new AccountLaunchError(
      account.id,
      AccountProblem.SecretMissing,
      `Account "${account.label}" has no secret set through 10db`,
    );
    if (account.secretRef === null || account.secretFingerprint === null) throw missing;
    const secret = opts.keychain.read(account.secretRef);
    if (secret === null) throw missing;
    if (secretFingerprint(secret) !== account.secretFingerprint)
      throw new AccountLaunchError(
        account.id,
        AccountProblem.SecretChanged,
        `The Keychain secret of account "${account.label}" changed outside 10db`,
      );
    return secret;
  }

  function build(account: AccountRow): Record<string, string> {
    const login = projectEnv();
    const env: Record<string, string> = {
      ...withoutVars(login, account.kind),
      [CLIENT_APP_VAR]: opts.clientApp,
    };
    // Every kind runs on its own directory, so a keyed session never meets the default account's saved login;
    // null is Claude Code's default directory, which only the default account uses.
    if (account.configDir !== null)
      env[account.kind === AccountKind.CodexSignin ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] =
        account.configDir;
    switch (account.kind) {
      case AccountKind.ClaudeSubscription: {
        SubscriptionSettings.parse(account.settings);
        return env;
      }
      case AccountKind.AnthropicApiKey: {
        ApiKeySettings.parse(account.settings);
        env['ANTHROPIC_API_KEY'] = secretOf(account);
        return env;
      }
      case AccountKind.Bedrock: {
        const settings = BedrockSettings.parse(account.settings);
        env['CLAUDE_CODE_USE_BEDROCK'] = '1';
        env['AWS_REGION'] = settings.region;
        if (settings.awsProfile === null) env['AWS_BEARER_TOKEN_BEDROCK'] = secretOf(account);
        else env['AWS_PROFILE'] = settings.awsProfile;
        return env;
      }
      case AccountKind.Gateway: {
        const settings = GatewaySettings.parse(account.settings);
        env['ANTHROPIC_BASE_URL'] = settings.baseUrl;
        env['ANTHROPIC_AUTH_TOKEN'] = secretOf(account);
        return env;
      }
      case AccountKind.CodexSignin: {
        SubscriptionSettings.parse(account.settings);
        return env;
      }
    }
  }

  const expectation = (account: AccountRow): AccountExpectation => ({
    accountId: account.id,
    label: account.label,
    kind: account.kind,
    identity: account.expectedIdentity,
  });

  return {
    projectEnv,
    session(account, model, accountModels) {
      if (isModelTier(model)) throw new ModelNotLaunchableError(model);
      const own = accountModels.find((m) => m.model === model);
      return {
        env: build(account),
        model: own?.launchId ?? model,
        expect: expectation(account),
      };
    },
    probe(account) {
      return { env: build(account), expect: expectation(account) };
    },
    loginConfigDir() {
      const dir = opts.base['CLAUDE_CONFIG_DIR'];
      // A relative path depends on the shell's working directory, so it names no one directory.
      return dir !== undefined && isAbsolute(dir) ? dir : null;
    },
    loginCodexHome() {
      const dir = opts.base['CODEX_HOME'];
      // A relative path depends on the shell's working directory, so it names no one directory.
      return dir !== undefined && isAbsolute(dir) ? dir : null;
    },
    loginConfigDirWarning() {
      const dir = opts.base['CLAUDE_CONFIG_DIR'];
      if (dir === undefined || dir === '' || isAbsolute(dir)) return null;
      return "The login shell sets CLAUDE_CONFIG_DIR to a relative path, which names no one directory, so the default account runs on Claude Code's default directory (~/.claude). Set it to an absolute path and start 10db on a fresh data directory to run it there.";
    },
  };
}
