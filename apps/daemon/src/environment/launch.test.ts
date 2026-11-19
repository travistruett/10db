import { mintId } from '@10db/contracts';
import type { AccountRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { BILLING_SWITCH_VARS, createLauncher, secretFingerprint } from './index';

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

function account(overrides: Partial<AccountRow>): AccountRow {
  const id = overrides.id ?? mintId('Account');
  return {
    id,
    kind: 'claude_subscription',
    label: 'Company A',
    payer: '',
    expectedIdentity: 'a@example.com',
    configDir: '/data/accounts/acc_sub/claude',
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

const launcher = () =>
  createLauncher({
    base: BASE,
    clientApp: '10db/0.1.0',
    keychain: createMemoryKeychain({ 'account:k': SECRET }),
  });

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
    const row = account({
      kind: 'openrouter',
      expectedIdentity: null,
      secretRef: 'account:o',
      secretFingerprint: secretFingerprint(SECRET),
      configDir: null,
      laneCap: 0,
    });
    for (const launch of [
      () => watching.session(row, 'claude-sonnet-5-5', []),
      () => watching.probe(row),
    ])
      expect(launch).toThrow(
        expect.objectContaining({ name: 'AccountLaunchError', accountId: row.id }) as Error,
      );
    expect(reads).toBe(0);
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
});
