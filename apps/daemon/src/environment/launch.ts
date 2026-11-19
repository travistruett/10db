import {
  AccountKind,
  AccountProblem,
  ApiKeySettings,
  BedrockSettings,
  GatewaySettings,
  isModelTier,
  Provider,
  OPENROUTER_CANT_RUN_AGENTS,
  providerOf,
  runsAgents,
  SubscriptionSettings,
  type AccountId,
  type AccountModelDto,
  type AgentAccountKind,
  type SupportedAccountKind,
} from '@10db/contracts';
import { isAbsolute, join } from 'node:path';
import type { AccountRow } from '@10db/db';
import { CLAUDE_CODE_VERIFIED_ON } from './agent-pins';
import { readAccountSecret } from './account-secret';
import type { Keychain } from './keychain';
import {
  BILLING_SWITCH_PREFIXES,
  BILLING_SWITCH_VARS,
  NESTED_SESSION_VARS,
  OWN_PREFIX,
  stripBillingSwitches,
} from './session-env';

/** The Claude Code version the account variables and `accountInfo()` fields were verified on: the pinned release. */
export const ACCOUNT_NAMES_VERIFIED_ON = CLAUDE_CODE_VERIFIED_ON;

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
/** The families of provider switches a terminal clears, with 10db's own variables. */
const UNSET_PREFIXES: readonly string[] = [...BILLING_SWITCH_PREFIXES, OWN_PREFIX];
const CLIENT_APP_VAR = 'CLAUDE_AGENT_SDK_CLIENT_APP';

/** What a session on an account must report before its prompt (accounts spec §5). */
export interface AccountExpectation {
  readonly accountId: AccountId;
  readonly label: string;
  readonly kind: AgentAccountKind;
  /** The email (subscription) or organization (keyed) Claude Code must report; null compares none. */
  readonly identity: string | null;
}

export interface SessionLaunch {
  readonly env: Readonly<Record<string, string>>;
  /** What the CLI is launched with: the account's own ID for the model, or the canonical ID when it lists none. */
  readonly model: string;
  readonly expect: AccountExpectation;
}

/**
 * What the builder's own terminal runs an account's agent with: the variables to set and to unset (a name, or
 * every name under a prefix), and where its key is read. It holds no secret value: a key is read from the
 * Keychain by the helper or the script at run time.
 */
export interface TakeoverLaunch {
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  readonly unsetPrefixes: readonly string[];
  /** Variables the script fills from the Keychain account named, and exports. */
  readonly keychain: readonly { readonly variable: string; readonly account: string }[];
  /** The Keychain account the agent's key helper reads, for the kinds that allow one. */
  readonly apiKeyHelperAccount: string | null;
  /** The agent keeps its credentials from the commands it runs. */
  readonly scrub: boolean;
  /** What the CLI is launched with for the model. */
  readonly model: string;
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
  /**
   * The environment of the builder's own terminal on `account`: what a session sets, with a keyed account's secret
   * checked now and read by the terminal's helper or script, never held here. Throws what `session` does.
   */
  takeover(
    account: AccountRow,
    model: string,
    accountModels: readonly AccountModelDto[],
  ): TakeoverLaunch;
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

/**
 * Claude Code's cache of servers that needed a sign-in, in the session's config folder; null unless the
 * session reads another folder's sign-ins (both variables set, the lookup one possibly empty). Only an
 * account that shares the builder's entry has a cache that can be stale against it.
 */
export function staleNeedsAuthCache(env: Readonly<Record<string, string>>): string | null {
  const dir = env['CLAUDE_CONFIG_DIR'];
  if (dir === undefined || !Object.hasOwn(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR')) return null;
  return join(dir, 'mcp-needs-auth-cache.json');
}

/** Where a builder signs an MCP server in for a Claude session. */
export const McpSignInWhere = {
  BuildersClaudeCode: 'builders_claude_code',
  ThisAccount: 'this_account',
  NotYet: 'not_yet',
} as const;
export type McpSignInWhere = (typeof McpSignInWhere)[keyof typeof McpSignInWhere];

/** The login shell's absolute `CLAUDE_CONFIG_DIR`, or null; a relative path names no one directory. */
export function loginConfigDirOf(base: Readonly<Record<string, string>>): string | null {
  const dir = base['CLAUDE_CONFIG_DIR'];
  return dir !== undefined && isAbsolute(dir) ? dir : null;
}

/**
 * A session's environment turned into a connector probe's: the same account and billing variables, on a
 * fresh `CLAUDE_CONFIG_DIR`, with the keychain lookup pointed at the folder the session itself reads
 * (the empty string for Claude Code's default). The probe then reads the account's own login and writes
 * nothing of its own to the keychain.
 */
export function connectorProbeEnv(
  sessionEnv: Readonly<Record<string, string>>,
  freshDir: string,
): Record<string, string> {
  return {
    ...sessionEnv,
    CLAUDE_CONFIG_DIR: freshDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: sessionEnv['CLAUDE_CONFIG_DIR'] ?? '',
  };
}

/**
 * Where a Claude session's servers get signed in, from its launch environment: not at all on a Gateway
 * account, in the builder's own Claude Code when the session reads that entry (the default folder, the login
 * shell's folder, or a keyed account), and in the account's own folder otherwise. `loginConfigDir` is the
 * login shell's absolute `CLAUDE_CONFIG_DIR`, or null.
 */
export function mcpSignInWhere(
  kind: AgentAccountKind,
  env: Readonly<Record<string, string>>,
  loginConfigDir: string | null,
): McpSignInWhere {
  if (kind === AccountKind.Gateway) return McpSignInWhere.NotYet;
  const dir = env['CLAUDE_CONFIG_DIR'];
  if (dir !== undefined && dir === loginConfigDir) return McpSignInWhere.BuildersClaudeCode;
  if (dir !== undefined && !Object.hasOwn(env, 'CLAUDE_SECURESTORAGE_CONFIG_DIR'))
    return McpSignInWhere.ThisAccount;
  return McpSignInWhere.BuildersClaudeCode;
}

/** Starts the unmodified `claude` on an account's own folder, where `/mcp` signs its servers in; the path is one shell word even with spaces. */
export function claudeMcpSignInCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR=${quoted(configDir)} claude`;
}

/** Signs a ChatGPT plan in with the unmodified `codex`; the path is one shell word even with spaces. */
function codexSignInCommand(home: string): string {
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
  kind: AgentAccountKind,
  env: Readonly<Record<string, string>>,
  home: string,
): string {
  return providerOf(kind) === Provider.Codex
    ? (env['CODEX_HOME'] ?? join(home, '.codex'))
    : (env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude'));
}

/** The names a kind takes from its account only, so a terminal unsets them from the builder's shell. */
function droppedBy(kind: AgentAccountKind): readonly string[] {
  return kind === AccountKind.Bedrock
    ? AWS_LOGIN_VARS
    : kind === AccountKind.CodexSignin
      ? CODEX_LOGIN_VARS
      : [];
}

/** The login env minus what the kind takes from its account only. */
function withoutVars(
  login: Readonly<Record<string, string>>,
  kind: AgentAccountKind,
): Record<string, string> {
  const dropped = droppedBy(kind);
  return Object.fromEntries(Object.entries(login).filter(([name]) => !dropped.includes(name)));
}

export function createLauncher(opts: {
  readonly base: Readonly<Record<string, string>>;
  readonly clientApp: string;
  readonly keychain: Keychain;
}): Launcher {
  const projectEnv = (): Record<string, string> => stripBillingSwitches(opts.base);

  function secretOf(account: AccountRow): string {
    const checked = readAccountSecret(account, opts.keychain);
    switch (checked.state) {
      case 'set':
        return checked.secret;
      case 'missing':
        throw new AccountLaunchError(
          account.id,
          AccountProblem.SecretMissing,
          `Account "${account.label}" has no secret set through 10db`,
        );
      case 'changed':
        throw new AccountLaunchError(
          account.id,
          AccountProblem.SecretChanged,
          `The Keychain secret of account "${account.label}" changed outside 10db`,
        );
    }
  }

  /** The kind of an account a session can run on; an OpenRouter account is refused before any secret is read. */
  function agentKindOf(account: AccountRow): AgentAccountKind {
    if (!runsAgents(account.kind))
      throw new AccountLaunchError(
        account.id,
        AccountProblem.CannotBill,
        `Account "${account.label}": ${OPENROUTER_CANT_RUN_AGENTS}`,
      );
    return account.kind;
  }

  /**
   * Where the builder's own Claude Code keeps its sign-ins, as `CLAUDE_SECURESTORAGE_CONFIG_DIR` names it:
   * the login shell's folder, or the empty string for Claude Code's default. Set, even empty, it points the
   * keychain lookup at that entry whatever the session's own `CLAUDE_CONFIG_DIR` is.
   */
  function sharedEntryDir(): string {
    return loginConfigDirOf(opts.base) ?? '';
  }

  function build(account: AccountRow): Record<string, string> {
    const kind = agentKindOf(account);
    const login = projectEnv();
    const env: Record<string, string> = {
      ...withoutVars(login, kind),
      [CLIENT_APP_VAR]: opts.clientApp,
    };
    // Every kind runs on its own directory, so a keyed session never meets the default account's saved login;
    // null is Claude Code's default directory, which only the default account uses. A keyed session still
    // reads the builder's MCP sign-ins, as its own Claude Code does on Bedrock, and runs as its key: the
    // preflight's checkAccount and the init check confirm it.
    if (account.configDir !== null)
      env[kind === AccountKind.CodexSignin ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] =
        account.configDir;
    switch (kind) {
      case AccountKind.ClaudeSubscription: {
        SubscriptionSettings.parse(account.settings);
        return env;
      }
      case AccountKind.AnthropicApiKey: {
        ApiKeySettings.parse(account.settings);
        env['ANTHROPIC_API_KEY'] = secretOf(account);
        env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = sharedEntryDir();
        return env;
      }
      case AccountKind.Bedrock: {
        const settings = BedrockSettings.parse(account.settings);
        env['CLAUDE_CODE_USE_BEDROCK'] = '1';
        env['AWS_REGION'] = settings.region;
        if (settings.awsProfile === null) env['AWS_BEARER_TOKEN_BEDROCK'] = secretOf(account);
        else env['AWS_PROFILE'] = settings.awsProfile;
        env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = sharedEntryDir();
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

  /** What the account sets for a terminal, and how its key reaches the agent. */
  function takeoverOf(account: AccountRow): Omit<TakeoverLaunch, 'unset' | 'model'> {
    const kind = agentKindOf(account);
    const set: Record<string, string> = {};
    if (account.configDir !== null)
      set[kind === AccountKind.CodexSignin ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] =
        account.configDir;
    const none = { keychain: [], apiKeyHelperAccount: null, scrub: false };
    // A key is checked here and read later by whoever uses it; secretRef is set when the secret passes.
    const keyRef = (): string => {
      secretOf(account);
      if (account.secretRef === null) throw new Error('a checked secret has a reference');
      return account.secretRef;
    };
    switch (kind) {
      case AccountKind.ClaudeSubscription:
        SubscriptionSettings.parse(account.settings);
        return { set, unsetPrefixes: UNSET_PREFIXES, ...none };
      case AccountKind.AnthropicApiKey:
        ApiKeySettings.parse(account.settings);
        set['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = sharedEntryDir();
        return {
          set,
          unsetPrefixes: UNSET_PREFIXES,
          ...none,
          apiKeyHelperAccount: keyRef(),
        };
      case AccountKind.Bedrock: {
        const settings = BedrockSettings.parse(account.settings);
        set['CLAUDE_CODE_USE_BEDROCK'] = '1';
        set['AWS_REGION'] = settings.region;
        set['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = sharedEntryDir();
        if (settings.awsProfile !== null) {
          set['AWS_PROFILE'] = settings.awsProfile;
          return { set, unsetPrefixes: UNSET_PREFIXES, ...none };
        }
        // The key sits in the agent's environment, so it is kept from the commands the agent runs.
        return {
          set,
          unsetPrefixes: UNSET_PREFIXES,
          keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: keyRef() }],
          apiKeyHelperAccount: null,
          scrub: true,
        };
      }
      case AccountKind.Gateway: {
        const settings = GatewaySettings.parse(account.settings);
        set['ANTHROPIC_BASE_URL'] = settings.baseUrl;
        return {
          set,
          unsetPrefixes: UNSET_PREFIXES,
          ...none,
          apiKeyHelperAccount: keyRef(),
        };
      }
      case AccountKind.CodexSignin:
        SubscriptionSettings.parse(account.settings);
        return { set, unsetPrefixes: UNSET_PREFIXES, ...none };
    }
  }

  const expectation = (account: AccountRow): AccountExpectation => ({
    accountId: account.id,
    label: account.label,
    kind: agentKindOf(account),
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
    takeover(account, model, accountModels) {
      if (isModelTier(model)) throw new ModelNotLaunchableError(model);
      const own = accountModels.find((m) => m.model === model);
      const launch = takeoverOf(account);
      const owned = new Set([
        ...Object.keys(launch.set),
        ...launch.keychain.map((k) => k.variable),
      ]);
      const unset = [
        ...new Set([
          ...BILLING_SWITCH_VARS,
          ...NESTED_SESSION_VARS,
          ...droppedBy(agentKindOf(account)),
        ]),
      ].filter((name) => !owned.has(name));
      return { ...launch, unset, model: own?.launchId ?? model };
    },
    probe(account) {
      return { env: build(account), expect: expectation(account) };
    },
    loginConfigDir() {
      return loginConfigDirOf(opts.base);
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
