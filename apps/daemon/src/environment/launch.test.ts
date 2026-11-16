import {
  mintId,
  type AccountModelDto,
  type AccountProblem,
  type AgentAccountKind,
} from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import {
  AccountLaunchError,
  BILLING_SWITCH_VARS,
  NESTED_SESSION_VARS,
  SECRET_VARIABLES,
  createLauncher,
  claudeMcpSignInCommand,
  connectorProbeEnv,
  codexSignInCommand,
  mcpSignInWhere,
  McpSignInWhere,
  secretFingerprint,
  sessionConfigDir,
  signInCommand,
  signInCommandFor,
  staleNeedsAuthCache,
} from './index';

/** A login shell that exports every switch a builder might have in .zshrc. */
const BASE: Readonly<Record<string, string>> = {
  PATH: '/h/b/.local/bin:/usr/bin:/bin',
  HOME: '/h/b',
  ANTHROPIC_API_KEY: 'sk-ant-from-zshrc',
  ANTHROPIC_AUTH_TOKEN: 'token-from-zshrc',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-y',
  CLAUDE_CONFIG_DIR: '/h/b/.claude-other',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-zshrc',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-from-zshrc',
  AWS_PROFILE: 'dev',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIA-login',
  AWS_SECRET_ACCESS_KEY: 'login-secret',
  AWS_WEB_IDENTITY_TOKEN_FILE: 'login-value',
  AWS_ROLE_ARN: 'login-value',
  AWS_CONTAINER_CREDENTIALS_FULL_URI: 'login-value',
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: 'login-value',
  AWS_CONTAINER_AUTHORIZATION_TOKEN: 'login-value',
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'login-value',
  OPENAI_API_KEY: 'sk-from-zshrc',
  CODEX_API_KEY: 'codex-from-zshrc',
  OPENAI_BASE_URL: 'https://openai-proxy.example',
  CODEX_ACCESS_TOKEN: 'access-from-zshrc',
  CODEX_HOME: '/h/b/.codex-other',
  CLAUDECODE: '1',
  GIT_DIR: '/elsewhere/.git',
  TENDB_DATA_DIR: '/data',
};
const SECRET = 'sk-ant-api03-account-secret';
const SUB_DIR = '/data/accounts/acc_sub/claude';
const KEY_DIR = '/data/accounts/acc_key/claude';

function account(overrides: Partial<AccountRow>): AccountRow {
  const id = overrides.id ?? mintId('Account');
  return {
    id,
    kind: 'claude_subscription',
    label: 'Company A',
    payer: '',
    expectedIdentity: 'a@example.com',
    configDir: SUB_DIR,
    secretRef: null,
    secretFingerprint: null,
    settings: {},
    laneCap: 4,
    monthlyCapUsd: null,
    archived: false,
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    ...overrides,
  };
}
const keyed = (overrides: Partial<AccountRow>) =>
  account({
    configDir: KEY_DIR,
    expectedIdentity: null,
    secretRef: 'account:k',
    secretFingerprint: secretFingerprint(SECRET),
    ...overrides,
  });

const launcher = (
  items: Record<string, string> = { 'account:k': SECRET },
  base: Readonly<Record<string, string>> = BASE,
) => createLauncher({ base, clientApp: '10db/0.1.0', keychain: createMemoryKeychain(items) });

/** A login shell that doesn't move Claude Code's directory. */
const DEFAULT_FOLDER_BASE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BASE).filter(([name]) => name !== 'CLAUDE_CONFIG_DIR'),
);

describe('the project env', () => {
  it('strips every billing switch and 10db variable, and adds no account credential', () => {
    const env = launcher().projectEnv();
    for (const name of [
      ...BILLING_SWITCH_VARS,
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'CLAUDECODE',
      'GIT_DIR',
      'TENDB_DATA_DIR',
    ])
      expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({ PATH: BASE['PATH'], HOME: '/h/b', AWS_PROFILE: 'dev' });
  });
});

describe('a session launch', () => {
  it.each<{
    name: string;
    row: AccountRow;
    adds: Record<string, string>;
    absent: string[];
    /** The login shell; the one that moves Claude Code's directory unless a row says otherwise. */
    base?: Readonly<Record<string, string>>;
  }>([
    {
      name: 'a subscription on its own directory',
      row: account({}),
      adds: { CLAUDE_CONFIG_DIR: SUB_DIR },
      absent: [
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      ],
    },
    {
      name: "the default account on the login shell's own directory",
      row: account({ label: 'Claude plan', configDir: '/h/b/.claude-other' }),
      adds: { CLAUDE_CONFIG_DIR: '/h/b/.claude-other' },
      absent: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
    },
    {
      name: "the default account on Claude Code's default directory, which the login shell's value never overrides",
      row: account({ label: 'Claude plan', configDir: null }),
      adds: {},
      absent: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
    },
    {
      name: 'an API key on its own directory',
      row: keyed({ kind: 'anthropic_api_key' }),
      adds: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CONFIG_DIR: KEY_DIR },
      absent: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    },
    {
      name: "an API key reads the entry of Claude Code's default directory when the login shell moves none",
      row: keyed({ kind: 'anthropic_api_key' }),
      adds: { ANTHROPIC_API_KEY: SECRET, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      absent: [],
      base: DEFAULT_FOLDER_BASE,
    },
    {
      name: "an API key reads the entry of the login shell's moved directory",
      row: keyed({ kind: 'anthropic_api_key' }),
      adds: {
        ANTHROPIC_API_KEY: SECRET,
        CLAUDE_CONFIG_DIR: KEY_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other',
      },
      absent: [],
    },
    {
      name: 'Bedrock on a profile',
      row: account({
        kind: 'bedrock',
        configDir: KEY_DIR,
        expectedIdentity: null,
        settings: { region: 'us-west-2', awsProfile: 'client-c' },
      }),
      adds: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'client-c',
        CLAUDE_CONFIG_DIR: KEY_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other',
      },
      absent: [
        'AWS_WEB_IDENTITY_TOKEN_FILE',
        'AWS_ROLE_ARN',
        'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
        'AWS_CONTAINER_AUTHORIZATION_TOKEN',
        'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_BEARER_TOKEN_BEDROCK',
        'ANTHROPIC_API_KEY',
      ],
    },
    {
      name: 'Bedrock on a bearer token',
      row: keyed({ kind: 'bedrock', settings: { region: 'eu-central-1', awsProfile: null } }),
      adds: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'eu-central-1',
        AWS_BEARER_TOKEN_BEDROCK: SECRET,
        CLAUDE_CONFIG_DIR: KEY_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other',
      },
      absent: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    },
    {
      name: 'a gateway',
      row: keyed({
        kind: 'gateway',
        settings: { baseUrl: 'https://openrouter.ai/api' },
      }),
      adds: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: SECRET,
        CLAUDE_CONFIG_DIR: KEY_DIR,
      },
      absent: ['ANTHROPIC_API_KEY', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
    },
  ])('$name', ({ row, adds, absent, base }) => {
    const launch = launcher(undefined, base).session(row, 'claude-sonnet-5-5', []);
    expect(launch.env).toMatchObject({
      ...adds,
      CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0',
      PATH: BASE['PATH'],
    });
    for (const name of absent) expect(launch.env).not.toHaveProperty(name);
    expect(launch.expect).toEqual({
      accountId: row.id,
      label: row.label,
      kind: row.kind,
      identity: row.expectedIdentity,
    });
  });

  it.each<{
    name: string;
    items: Record<string, string>;
    row: AccountRow;
    problem: AccountProblem;
  }>([
    {
      name: 'a missing secret',
      items: {},
      row: keyed({ kind: 'anthropic_api_key' }),
      problem: 'secret_missing',
    },
    {
      name: 'a secret never set through 10db',
      items: { 'account:k': SECRET },
      row: keyed({
        kind: 'gateway',
        secretFingerprint: null,
        settings: { baseUrl: 'https://g.example' },
      }),
      problem: 'secret_missing',
    },
    {
      name: 'a secret changed outside 10db',
      items: { 'account:k': 'sk-ant-api03-someone-elses' },
      row: keyed({ kind: 'anthropic_api_key' }),
      problem: 'secret_changed',
    },
  ])('refuses $name before anything starts, naming no value', ({ items, row, problem }) => {
    let thrown: unknown;
    try {
      launcher(items).session(row, 'claude-sonnet-5-5', []);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountLaunchError);
    expect(thrown).toMatchObject({ accountId: row.id, problem });
    expect(String(thrown)).not.toContain('sk-ant');
  });

  it('refuses an OpenRouter account without reading the Keychain, session and probe alike', () => {
    let reads = 0;
    const memory = createMemoryKeychain({ 'account:o': SECRET });
    const watching = createLauncher({
      base: BASE,
      clientApp: '10db/0.1.0',
      keychain: {
        ...memory,
        read: (name) => {
          reads += 1;
          return memory.read(name);
        },
      },
    });
    const row = keyed({ kind: 'openrouter', secretRef: 'account:o', configDir: null, laneCap: 0 });
    for (const launch of [
      () => watching.session(row, 'claude-sonnet-5-5', []),
      () => watching.probe(row),
    ])
      expect(launch).toThrow(
        expect.objectContaining({ name: 'AccountLaunchError', accountId: row.id }) as Error,
      );
    expect(reads).toBe(0);
  });

  it('builds a probe like a session, without a model', () => {
    const row = account({ expectedIdentity: null });
    const probe = launcher().probe(row);
    expect(probe.env['CLAUDE_CONFIG_DIR']).toBe(row.configDir);
    expect(probe.expect.identity).toBeNull();
  });

  it('builds a keyed probe with the same sign-in lookup as its session', () => {
    const row = keyed({ kind: 'anthropic_api_key' });
    expect(launcher().probe(row).env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(
      launcher().session(row, 'claude-sonnet-5-5', []).env['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
    );
    expect(launcher(undefined, DEFAULT_FOLDER_BASE).probe(row).env).toMatchObject({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    });
  });
});

describe('a ChatGPT sign-in launch', () => {
  const CODEX_DIR = '/d/acc/codex';
  const codexAccount = account({
    kind: 'codex_signin',
    label: 'ChatGPT Pro',
    configDir: CODEX_DIR,
    expectedIdentity: 'a@example.com · w1',
  });

  it('runs on its own CODEX_HOME and none of the OpenAI credentials', () => {
    const { env } = launcher().session(codexAccount, 'gpt-5.6-sol', []);
    expect(env['CODEX_HOME']).toBe(CODEX_DIR);
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'])
      expect(env).not.toHaveProperty(name);
    expect(launcher().projectEnv()).toHaveProperty('OPENAI_API_KEY');
  });

  it('never inherits the login shell CODEX_HOME when it has no directory', () => {
    const { env } = launcher().session({ ...codexAccount, configDir: null }, 'gpt-5.6-sol', []);
    expect(env).not.toHaveProperty('CODEX_HOME');
  });

  it('signs in with the unmodified codex, one shell word even with spaces', () => {
    expect(codexSignInCommand('/a b/codex')).toBe("CODEX_HOME='/a b/codex' codex login");
  });

  it.each<{ name: string; row: AccountRow; command: string }>([
    {
      name: 'a ChatGPT sign-in',
      row: codexAccount,
      command: `CODEX_HOME='${CODEX_DIR}' codex login`,
    },
    { name: 'a subscription', row: account({}), command: signInCommand(SUB_DIR) },
  ])('picks the sign-in command of $name', ({ row, command }) => {
    expect(signInCommandFor(row)).toBe(command);
  });
});

describe('sessionConfigDir', () => {
  it.each<{ name: string; kind: AgentAccountKind; env: Record<string, string>; dir: string }>([
    {
      name: 'CODEX_HOME for a ChatGPT sign-in',
      kind: 'codex_signin',
      env: { CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/d' },
      dir: '/c',
    },
    {
      name: "a ChatGPT sign-in's default directory",
      kind: 'codex_signin',
      env: {},
      dir: '/h/b/.codex',
    },
    {
      name: 'CLAUDE_CONFIG_DIR for a subscription, whatever CODEX_HOME holds',
      kind: 'claude_subscription',
      env: { CODEX_HOME: '/h/b/.codex-other', CLAUDE_CONFIG_DIR: '/d' },
      dir: '/d',
    },
    {
      name: "the default account's Claude directory, whatever CODEX_HOME holds",
      kind: 'claude_subscription',
      env: { CODEX_HOME: '/h/b/.codex-other' },
      dir: '/h/b/.claude',
    },
    {
      name: 'the default Claude directory for a gateway',
      kind: 'gateway',
      env: {},
      dir: '/h/b/.claude',
    },
  ])('reads $name', ({ kind, env, dir }) => {
    expect(sessionConfigDir(kind, env, '/h/b')).toBe(dir);
  });

  it('carries the login shell CODEX_HOME through a Claude launch without using it', () => {
    const { env } = launcher().session(account({}), 'claude-sonnet-5-5', []);
    expect(sessionConfigDir('claude_subscription', env, '/h/b')).toBe(SUB_DIR);
    const login = launcher().session(account({ configDir: null }), 'claude-sonnet-5-5', []);
    expect(sessionConfigDir('claude_subscription', login.env, '/h/b')).toBe('/h/b/.claude');
  });
});

describe("the login shell's config directory", () => {
  it.each<[string, Record<string, string>, string | null, boolean]>([
    [
      'an absolute directory',
      { CLAUDE_CONFIG_DIR: '/h/b/.claude-other' },
      '/h/b/.claude-other',
      false,
    ],
    ['none set', {}, null, false],
    ['an empty value', { CLAUDE_CONFIG_DIR: '' }, null, false],
    ['a relative path, ignored with a warning', { CLAUDE_CONFIG_DIR: '.claude-other' }, null, true],
  ])('%s', (_name, vars, dir, warns) => {
    const login = createLauncher({
      base: { PATH: '/bin', ...vars },
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    });
    expect(login.loginConfigDir()).toBe(dir);
    const warning = login.loginConfigDirWarning();
    expect(warning !== null).toBe(warns);
    // It names the variable, never the builder's value.
    if (warning) expect(warning).toContain('CLAUDE_CONFIG_DIR');
    expect(warning ?? '').not.toContain('.claude-other');
  });
});

describe("the login shell's Codex home", () => {
  it.each<[string, Record<string, string>, string | null]>([
    ['an absolute directory', { CODEX_HOME: '/h/b/.codex-other' }, '/h/b/.codex-other'],
    ['none set', {}, null],
    ['an empty value', { CODEX_HOME: '' }, null],
    ['a relative path', { CODEX_HOME: '.codex-other' }, null],
  ])('%s', (_name, vars, dir) => {
    const login = createLauncher({
      base: { PATH: '/bin', ...vars },
      clientApp: 'test',
      keychain: createMemoryKeychain(),
    });
    expect(login.loginCodexHome()).toBe(dir);
  });
});

describe('signInCommand', () => {
  it.each<[string | null, string]>([
    [null, 'env -u CLAUDE_CONFIG_DIR claude /login'],
    [
      '/data/accounts/acc_1/claude',
      "CLAUDE_CONFIG_DIR='/data/accounts/acc_1/claude' claude /login",
    ],
    [
      '/Users/b/Library/Application Support/10db/accounts/acc_1/claude',
      "CLAUDE_CONFIG_DIR='/Users/b/Library/Application Support/10db/accounts/acc_1/claude' claude /login",
    ],
    ["/tmp/o'brien/claude", "CLAUDE_CONFIG_DIR='/tmp/o'\\''brien/claude' claude /login"],
  ])('quotes %s as one shell word', (configDir, command) => {
    expect(signInCommand(configDir)).toBe(command);
  });
});

describe('claudeMcpSignInCommand', () => {
  it.each<[string, string]>([
    ['/data/accounts/acc_1/claude', "CLAUDE_CONFIG_DIR='/data/accounts/acc_1/claude' claude"],
    ["/tmp/o'brien/claude", "CLAUDE_CONFIG_DIR='/tmp/o'\\''brien/claude' claude"],
    [
      '/Users/b/Library/Application Support/10db/acc_1/claude',
      "CLAUDE_CONFIG_DIR='/Users/b/Library/Application Support/10db/acc_1/claude' claude",
    ],
  ])('runs claude in %s as one shell word, with no login', (configDir, command) => {
    expect(claudeMcpSignInCommand(configDir)).toBe(command);
  });
});

describe('staleNeedsAuthCache', () => {
  it.each<[string, Record<string, string>, string | null]>([
    [
      'both variables set, the second empty',
      { CLAUDE_CONFIG_DIR: '/d', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      '/d/mcp-needs-auth-cache.json',
    ],
    [
      'both variables set',
      { CLAUDE_CONFIG_DIR: '/d', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' },
      '/d/mcp-needs-auth-cache.json',
    ],
    ['only the config directory', { CLAUDE_CONFIG_DIR: '/d' }, null],
    ['only the lookup directory', { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, null],
    ['neither', {}, null],
  ])('%s', (_name, env, expected) => {
    expect(staleNeedsAuthCache(env)).toBe(expected);
  });
});

describe('mcpSignInWhere', () => {
  const LOGIN = '/h/b/.claude-other';
  it.each<[string, AgentAccountKind, Record<string, string>, McpSignInWhere]>([
    ['Gateway', 'gateway', { CLAUDE_CONFIG_DIR: '/d' }, McpSignInWhere.NotYet],
    [
      'a keyed account on the shared entry',
      'anthropic_api_key',
      { CLAUDE_CONFIG_DIR: '/d', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      McpSignInWhere.BuildersClaudeCode,
    ],
    [
      'a subscription on the login shell directory',
      'claude_subscription',
      { CLAUDE_CONFIG_DIR: LOGIN },
      McpSignInWhere.BuildersClaudeCode,
    ],
    [
      'a subscription on its own directory',
      'claude_subscription',
      { CLAUDE_CONFIG_DIR: '/d' },
      McpSignInWhere.ThisAccount,
    ],
    [
      'a subscription on the default directory',
      'claude_subscription',
      {},
      McpSignInWhere.BuildersClaudeCode,
    ],
  ])('%s', (_name, kind, env, expected) => {
    expect(mcpSignInWhere(kind, env, LOGIN)).toBe(expected);
  });
});

describe('connectorProbeEnv', () => {
  const FRESH = '/data/connector-probe/probe-1/config';
  it.each<{ name: string; row: AccountRow; lookup: string }>([
    {
      name: "the default account on Claude Code's default folder reads the default entry",
      row: account({ configDir: null }),
      lookup: '',
    },
    {
      name: "the default account on the login shell's folder reads that folder's entry",
      row: account({ configDir: '/h/b/.claude-other' }),
      lookup: '/h/b/.claude-other',
    },
    { name: 'an own-folder subscription reads its folder', row: account({}), lookup: SUB_DIR },
  ])('$name', ({ row, lookup }) => {
    const sessionEnv = launcher().session(row, 'sonnet', []).env;
    const env = connectorProbeEnv(sessionEnv, FRESH);
    expect(env).toMatchObject({
      CLAUDE_CONFIG_DIR: FRESH,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: lookup,
      CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0',
    });
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'])
      expect(env).not.toHaveProperty(name);
  });
});

describe('a takeover launch', () => {
  const CODEX_DIR = '/d/acc/codex';
  const bedrockKey = keyed({
    kind: 'bedrock',
    settings: { region: 'eu-central-1', awsProfile: null },
  });
  const bedrockProfile = account({
    kind: 'bedrock',
    configDir: KEY_DIR,
    expectedIdentity: null,
    settings: { region: 'us-west-2', awsProfile: 'client-c' },
  });
  const codex = account({ kind: 'codex_signin', configDir: CODEX_DIR });

  it.each<{
    name: string;
    row: AccountRow;
    set: Record<string, string>;
    keychain: { variable: string; account: string }[];
    helper: string | null;
    scrub: boolean;
    /** Names the unset must hold beyond the billing switches and nested markers. */
    unsets: string[];
  }>([
    {
      name: 'a plan on its own directory',
      row: account({}),
      set: { CLAUDE_CONFIG_DIR: SUB_DIR },
      keychain: [],
      helper: null,
      scrub: false,
      unsets: [],
    },
    {
      name: 'a plan on the default directory',
      row: account({ configDir: null }),
      set: {},
      keychain: [],
      helper: null,
      scrub: false,
      unsets: ['CLAUDE_CONFIG_DIR'],
    },
    {
      name: 'an API key, read by the helper and never in the environment',
      row: keyed({ kind: 'anthropic_api_key' }),
      set: { CLAUDE_CONFIG_DIR: KEY_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other' },
      keychain: [],
      helper: 'account:k',
      scrub: false,
      unsets: ['ANTHROPIC_API_KEY'],
    },
    {
      name: 'a Bedrock key, read by the script and scrubbed from commands',
      row: bedrockKey,
      set: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'eu-central-1',
        CLAUDE_CONFIG_DIR: KEY_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other',
      },
      keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }],
      helper: null,
      scrub: true,
      unsets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
    },
    {
      name: 'a Bedrock profile',
      row: bedrockProfile,
      set: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'client-c',
        CLAUDE_CONFIG_DIR: KEY_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other',
      },
      keychain: [],
      helper: null,
      scrub: false,
      unsets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK'],
    },
    {
      name: 'a gateway, read by the helper',
      row: keyed({ kind: 'gateway', settings: { baseUrl: 'https://openrouter.ai/api' } }),
      set: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', CLAUDE_CONFIG_DIR: KEY_DIR },
      keychain: [],
      helper: 'account:k',
      scrub: false,
      unsets: ['ANTHROPIC_AUTH_TOKEN'],
    },
    {
      name: 'a ChatGPT plan',
      row: codex,
      set: { CODEX_HOME: CODEX_DIR },
      keychain: [],
      helper: null,
      scrub: false,
      unsets: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'],
    },
  ])('$name', ({ row, set, keychain, helper, scrub, unsets }) => {
    const launch = launcher().takeover(row, 'claude-sonnet-5-5', []);
    expect(launch.set).toEqual(set);
    expect(launch.keychain).toEqual(keychain);
    expect(launch.apiKeyHelperAccount).toBe(helper);
    expect(launch.scrub).toBe(scrub);
    expect(launch.unset).toEqual(expect.arrayContaining([...unsets]));
    expect(launch.unset).toEqual(expect.arrayContaining([...NESTED_SESSION_VARS]));
    expect(launch.unsetPrefixes).toEqual(
      expect.arrayContaining(['ANTHROPIC_DEFAULT_', 'CLAUDE_CODE_USE_', 'TENDB_']),
    );
    // No credential is in the environment, and nothing both set and unset.
    for (const name of SECRET_VARIABLES) expect(launch.set).not.toHaveProperty(name);
    const owned = [...Object.keys(launch.set), ...launch.keychain.map((k) => k.variable)];
    for (const name of owned) expect(launch.unset).not.toContain(name);
    // Every billing switch the account doesn't own is dropped from the builder's shell.
    expect(launch.unset).toEqual(
      expect.arrayContaining(BILLING_SWITCH_VARS.filter((name) => !owned.includes(name))),
    );
    expect(JSON.stringify(launch)).not.toContain(SECRET);
  });

  it('launches the account’s own ID for the model, or the canonical one', () => {
    expect(launcher().takeover(account({}), 'claude-sonnet-5-5', []).model).toBe(
      'claude-sonnet-5-5',
    );
    const row = account({});
    const listed: AccountModelDto[] = [
      {
        accountId: row.id,
        model: 'claude-sonnet-5-5',
        family: null,
        launchId: 'us.anthropic.sonnet-5-5',
        efforts: [],
        unusable: false,
        wordingMarkEndsAt: null,
        inputPrice: null,
        outputPrice: null,
        lastSeenAt: '2026-10-22T12:00:00.000Z',
      },
    ];
    expect(launcher().takeover(row, 'claude-sonnet-5-5', listed).model).toBe(
      'us.anthropic.sonnet-5-5',
    );
  });

  it.each([
    ['missing', {}, 'secret_missing'],
    ['changed', { 'account:k': 'another-secret' }, 'secret_changed'],
  ] as const)('refuses a keyed account whose secret is %s', (_name, items, problem) => {
    let error: unknown;
    try {
      launcher(items).takeover(keyed({ kind: 'anthropic_api_key' }), 'claude-sonnet-5-5', []);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof AccountLaunchError)) throw new Error('no AccountLaunchError');
    expect(error.problem).toBe(problem);
  });
});
