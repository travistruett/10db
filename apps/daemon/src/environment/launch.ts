import {
  AccountKind,
  AccountProblem,
  ApiKeySettings,
  BedrockSettings,
  GatewaySettings,
  SubscriptionSettings,
  type AccountId,
  type SupportedAccountKind,
} from '@10db/contracts';
import { isAbsolute } from 'node:path';
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
const CLIENT_APP_VAR = 'CLAUDE_AGENT_SDK_CLIENT_APP';

/** What a session on an account must report before its prompt (accounts spec §5). */
interface AccountExpectation {
  readonly accountId: AccountId;
  readonly label: string;
  readonly kind: SupportedAccountKind;
  /** The email (subscription) or organization (keyed) Claude Code must report; null compares none. */
  readonly identity: string | null;
}

interface SessionLaunch {
  readonly env: Readonly<Record<string, string>>;
  /** The alias, or the channel's model ID from the account's model map. */
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

/** The one owner of account variables (accounts spec §3). */
interface Launcher {
  /** The login env with every billing switch stripped: for the gate and the repo's MCP servers. */
  projectEnv(): Record<string, string>;
  /** A session on `account` asking for `alias`; reads a keyed account's secret now and caches nothing. */
  session(account: AccountRow, alias: string): SessionLaunch;
  /** The same environment, for reading who the account is without a prompt. */
  probe(account: AccountRow): ProbeLaunch;
  /** Where the builder's own login lives when the login shell moves it: an absolute directory, or null for Claude Code's default. */
  loginConfigDir(): string | null;
  /** Why the login shell's directory was ignored (it is relative), naming the variable and never its value; null otherwise. */
  loginConfigDirWarning(): string | null;
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

  function build(account: AccountRow): {
    env: Record<string, string>;
    modelMap: Readonly<Record<string, string>>;
  } {
    const login = projectEnv();
    const env: Record<string, string> = {
      ...(account.kind === AccountKind.Bedrock
        ? Object.fromEntries(
            Object.entries(login).filter(([name]) => !AWS_LOGIN_VARS.includes(name)),
          )
        : login),
      [CLIENT_APP_VAR]: opts.clientApp,
    };
    // Every kind runs on its own directory, so a keyed session never meets the default account's saved login;
    // null is Claude Code's default directory, which only the default account uses.
    if (account.configDir !== null) env['CLAUDE_CONFIG_DIR'] = account.configDir;
    switch (account.kind) {
      case AccountKind.ClaudeSubscription: {
        const settings = SubscriptionSettings.parse(account.settings);
        return { env, modelMap: settings.modelMap ?? {} };
      }
      case AccountKind.AnthropicApiKey: {
        const settings = ApiKeySettings.parse(account.settings);
        env['ANTHROPIC_API_KEY'] = secretOf(account);
        return { env, modelMap: settings.modelMap ?? {} };
      }
      case AccountKind.Bedrock: {
        const settings = BedrockSettings.parse(account.settings);
        env['CLAUDE_CODE_USE_BEDROCK'] = '1';
        env['AWS_REGION'] = settings.region;
        if (settings.awsProfile === null) env['AWS_BEARER_TOKEN_BEDROCK'] = secretOf(account);
        else env['AWS_PROFILE'] = settings.awsProfile;
        return { env, modelMap: settings.modelMap ?? {} };
      }
      case AccountKind.Gateway: {
        const settings = GatewaySettings.parse(account.settings);
        env['ANTHROPIC_BASE_URL'] = settings.baseUrl;
        env['ANTHROPIC_AUTH_TOKEN'] = secretOf(account);
        return { env, modelMap: settings.modelMap ?? {} };
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
    session(account, alias) {
      const { env, modelMap } = build(account);
      return { env, model: modelMap[alias] ?? alias, expect: expectation(account) };
    },
    probe(account) {
      return { env: build(account).env, expect: expectation(account) };
    },
    loginConfigDir() {
      const dir = opts.base['CLAUDE_CONFIG_DIR'];
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
