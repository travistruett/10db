import { mintId, type AccountProblem } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import {
  AccountLaunchError,
  BILLING_SWITCH_VARS,
  createLauncher,
  secretFingerprint,
  signInCommand,
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

const launcher = (items: Record<string, string> = { 'account:k': SECRET }) =>
  createLauncher({ base: BASE, clientApp: '10db/0.1.0', keychain: createMemoryKeychain(items) });

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
    alias: string;
    adds: Record<string, string>;
    absent: string[];
    model: string;
  }>([
    {
      name: 'a subscription on its own directory',
      row: account({}),
      alias: 'sonnet',
      adds: { CLAUDE_CONFIG_DIR: SUB_DIR },
      absent: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
      model: 'sonnet',
    },
    {
      name: "the default account on the login shell's own directory",
      row: account({ label: 'Claude plan', configDir: '/h/b/.claude-other' }),
      alias: 'opus',
      adds: { CLAUDE_CONFIG_DIR: '/h/b/.claude-other' },
      absent: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
      model: 'opus',
    },
    {
      name: "the default account on Claude Code's default directory, which the login shell's value never overrides",
      row: account({ label: 'Claude plan', configDir: null }),
      alias: 'opus',
      adds: {},
      absent: ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'],
      model: 'opus',
    },
    {
      name: 'an API key on its own directory',
      row: keyed({ kind: 'anthropic_api_key' }),
      alias: 'haiku',
      adds: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CONFIG_DIR: KEY_DIR },
      absent: ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      model: 'haiku',
    },
    {
      name: 'Bedrock on a profile, with a model map',
      row: account({
        kind: 'bedrock',
        configDir: KEY_DIR,
        expectedIdentity: null,
        settings: {
          region: 'us-west-2',
          awsProfile: 'client-c',
          modelMap: { sonnet: 'us.anthropic.claude-sonnet-5-5-v1:0' },
        },
      }),
      alias: 'sonnet',
      adds: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'client-c',
        CLAUDE_CONFIG_DIR: KEY_DIR,
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
      model: 'us.anthropic.claude-sonnet-5-5-v1:0',
    },
    {
      name: 'Bedrock on a bearer token',
      row: keyed({ kind: 'bedrock', settings: { region: 'eu-central-1', awsProfile: null } }),
      alias: 'haiku',
      adds: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'eu-central-1',
        AWS_BEARER_TOKEN_BEDROCK: SECRET,
        CLAUDE_CONFIG_DIR: KEY_DIR,
      },
      absent: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
      model: 'haiku',
    },
    {
      name: 'a gateway with a model map',
      row: keyed({
        kind: 'gateway',
        settings: {
          baseUrl: 'https://openrouter.ai/api',
          modelMap: { haiku: '~anthropic/claude-haiku-latest' },
        },
      }),
      alias: 'haiku',
      adds: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: SECRET,
        CLAUDE_CONFIG_DIR: KEY_DIR,
      },
      absent: ['ANTHROPIC_API_KEY'],
      model: '~anthropic/claude-haiku-latest',
    },
  ])('$name', ({ row, alias, adds, absent, model }) => {
    const launch = launcher().session(row, alias);
    expect(launch.env).toMatchObject({
      ...adds,
      CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0',
      PATH: BASE['PATH'],
    });
    for (const name of absent) expect(launch.env).not.toHaveProperty(name);
    expect(launch.model).toBe(model);
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
      launcher(items).session(row, 'sonnet');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AccountLaunchError);
    expect(thrown).toMatchObject({ accountId: row.id, problem });
    expect(String(thrown)).not.toContain('sk-ant');
  });

  it('builds a probe like a session, without a model', () => {
    const row = account({ expectedIdentity: null });
    const probe = launcher().probe(row);
    expect(probe.env['CLAUDE_CONFIG_DIR']).toBe(row.configDir);
    expect(probe.expect.identity).toBeNull();
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
