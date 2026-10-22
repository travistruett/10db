import { BillingMode } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { keychainSecretsWith } from './session-env';
import {
  BILLING_SWITCH_VARS,
  buildSessionEnv,
  inferBillingMode,
  NESTED_SESSION_VARS,
  SessionEnvError,
  type SecretSource,
} from './index';

/** A login environment with every billing switch a builder might export in .zshrc. */
const BASE: Readonly<Record<string, string>> = {
  PATH: '/h/b/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  HOME: '/h/b',
  AWS_REGION: 'us-west-2',
  AWS_PROFILE: 'dev',
  ANTHROPIC_API_KEY: 'sk-ant-from-zshrc',
  ANTHROPIC_AUTH_TOKEN: 'auth-token',
  ANTHROPIC_BASE_URL: 'https://proxy.example',
  ANTHROPIC_MODEL: 'claude-x',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-y',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-z',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-gateway.example',
  ANTHROPIC_VERTEX_PROJECT_ID: 'vertex-project',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sub',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SSE_PORT: '5555',
  CLAUDE_PROJECT_DIR: '/h/b/Projects/other',
  TENDB_DATA_DIR: '/data',
  TENDB_FAKE_SCRIPTS: '/scripts.json',
};
const CLIENT_APP = '10db/0.1.0';
const keychain = (key: string | null): SecretSource => ({
  anthropicApiKey: () => key,
  artificialAnalysisKey: () => null,
});

describe('buildSessionEnv', () => {
  it('strips every billing switch for a subscription session, so .zshrc cannot move billing', () => {
    const env = buildSessionEnv({
      base: BASE,
      billingMode: BillingMode.Subscription,
      clientApp: CLIENT_APP,
      secrets: keychain('unused'),
    });
    for (const name of [
      ...BILLING_SWITCH_VARS,
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ])
      expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject({
      PATH: BASE['PATH'],
      HOME: '/h/b',
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'dev',
      CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
    });
    expect(inferBillingMode(env)).toBe(BillingMode.Subscription);
  });

  it.each([BillingMode.Subscription, BillingMode.ApiKey])(
    'strips whole provider-switch families in %s mode',
    (billingMode) => {
      const env = buildSessionEnv({
        base: BASE,
        billingMode,
        clientApp: CLIENT_APP,
        secrets: keychain('sk-ant-from-keychain'),
      });
      for (const name of [
        'CLAUDE_CODE_USE_MANTLE',
        'ANTHROPIC_VERTEX_PROJECT_ID',
        'ANTHROPIC_BEDROCK_BASE_URL',
      ])
        expect(env).not.toHaveProperty(name);
      // An env this builder produced must never select a second billing route.
      expect(inferBillingMode(env)).toBe(billingMode);
    },
  );

  it.each([BillingMode.Subscription, BillingMode.ApiKey, BillingMode.Bedrock])(
    'strips nested-session markers and TENDB_* in %s mode',
    (billingMode) => {
      const env = buildSessionEnv({
        base: BASE,
        billingMode,
        clientApp: CLIENT_APP,
        secrets: keychain('sk-ant-from-keychain'),
      });
      for (const name of NESTED_SESSION_VARS) expect(env).not.toHaveProperty(name);
      expect(Object.keys(env).filter((name) => name.startsWith('TENDB_'))).toEqual([]);
      expect(env['CLAUDE_AGENT_SDK_CLIENT_APP']).toBe(CLIENT_APP);
    },
  );

  it('takes the API key from the Keychain, never from the login environment', () => {
    const env = buildSessionEnv({
      base: BASE,
      billingMode: BillingMode.ApiKey,
      clientApp: CLIENT_APP,
      secrets: keychain('sk-ant-from-keychain'),
    });
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-from-keychain');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(inferBillingMode(env)).toBe(BillingMode.ApiKey);
  });

  it('explains how to add a missing API key without echoing any value', () => {
    const run = () =>
      buildSessionEnv({
        base: BASE,
        billingMode: BillingMode.ApiKey,
        clientApp: CLIENT_APP,
        secrets: keychain(null),
      });
    expect(run).toThrow(SessionEnvError);
    expect(run).toThrow(/security add-generic-password -s 10db -a anthropic-api-key -w/);
    let message = '';
    try {
      run();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain('sk-ant-from-zshrc');
  });

  it('keeps the AWS credentials and turns Bedrock on for a Bedrock session', () => {
    const env = buildSessionEnv({
      base: BASE,
      billingMode: BillingMode.Bedrock,
      clientApp: CLIENT_APP,
      secrets: keychain(null),
    });
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'dev',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-gateway.example',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_MANTLE');
    expect(env).not.toHaveProperty('ANTHROPIC_VERTEX_PROJECT_ID');
    expect(inferBillingMode(env)).toBe(BillingMode.Bedrock);
  });

  it('requires a region for Bedrock', () => {
    const noRegion = Object.fromEntries(
      Object.entries(BASE).filter(([name]) => name !== 'AWS_REGION'),
    );
    expect(() =>
      buildSessionEnv({
        base: noRegion,
        billingMode: BillingMode.Bedrock,
        clientApp: CLIENT_APP,
        secrets: keychain(null),
      }),
    ).toThrow(/AWS_REGION/);
    expect(() =>
      buildSessionEnv({
        base: { ...noRegion, AWS_DEFAULT_REGION: 'eu-west-1' },
        billingMode: BillingMode.Bedrock,
        clientApp: CLIENT_APP,
        secrets: keychain(null),
      }),
    ).not.toThrow();
  });

  it('drops the variables that name another repository and keeps profile git config and settings', () => {
    // A daemon started from a git hook captures GIT_DIR and friends; a session or gate that
    // inherited them would run git against that repository instead of the project's.
    const repositoryVariables = {
      GIT_DIR: '/h/b/Projects/other/.git',
      GIT_WORK_TREE: '/h/b/Projects/other',
      GIT_INDEX_FILE: '/h/b/Projects/other/.git/index',
      GIT_COMMON_DIR: '/h/b/Projects/other/.git',
      GIT_PREFIX: 'src/',
      GIT_OBJECT_DIRECTORY: '/h/b/Projects/other/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/h/b/Projects/other/.git/objects',
    };
    // Deliberate config from the builder's profile, such as a url rewrite, still applies.
    const kept = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_SSH_COMMAND: 'ssh -i /h/b/.ssh/work',
    };
    const env = buildSessionEnv({
      base: { ...BASE, ...repositoryVariables, ...kept },
      billingMode: BillingMode.Subscription,
      clientApp: CLIENT_APP,
      secrets: keychain(null),
    });
    for (const name of Object.keys(repositoryVariables)) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject(kept);
  });

  it('does not modify the captured base', () => {
    const before = { ...BASE };
    buildSessionEnv({
      base: BASE,
      billingMode: BillingMode.Subscription,
      clientApp: CLIENT_APP,
      secrets: keychain(null),
    });
    expect(BASE).toEqual(before);
  });
});

describe('inferBillingMode', () => {
  it.each([
    [{}, BillingMode.Subscription],
    [{ ANTHROPIC_API_KEY: 'k' }, BillingMode.ApiKey],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, BillingMode.Bedrock],
    [{ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k' }, BillingMode.Bedrock],
  ])('%o → %s', (env, mode) => {
    expect(inferBillingMode(env)).toBe(mode);
  });
});

describe('keychainSecrets', () => {
  const failure = (props: object) => () => {
    throw Object.assign(new Error('Command failed: security ... sk-ant-LEAK'), props);
  };

  it('reads the Artificial Analysis key from its own Keychain account', () => {
    const calls: (readonly string[])[] = [];
    const secrets = keychainSecretsWith((_cmd, args) => {
      calls.push(args);
      return 'aa-key\n';
    });
    expect(secrets.artificialAnalysisKey()).toBe('aa-key');
    expect(calls[0]).toEqual([
      'find-generic-password',
      '-s',
      '10db',
      '-a',
      'artificial-analysis-api-key',
      '-w',
    ]);
  });

  it('returns the key, trimmed', () => {
    expect(keychainSecretsWith(() => 'sk-ant-k\n').anthropicApiKey()).toBe('sk-ant-k');
  });

  it.each([
    ['empty output', () => '\n'],
    ['item not found (status 44)', failure({ status: 44 })],
  ])('reports no key for %s', (_name, exec) => {
    expect(keychainSecretsWith(exec).anthropicApiKey()).toBeNull();
  });

  it.each([
    ['user denied (status 51)', failure({ status: 51 }), /status 51/],
    ['locked keychain (status 36)', failure({ status: 36 }), /status 36/],
    ['timeout', failure({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }), /timed out/],
    ['cannot start', failure({ code: 'ENOENT' }), /ENOENT/],
  ])('throws a SessionEnvError for %s, naming no output', (_name, exec, message) => {
    const read = () => keychainSecretsWith(exec).anthropicApiKey();
    expect(read).toThrow(SessionEnvError);
    expect(read).toThrow(message);
    expect(read).not.toThrow(/LEAK/);
  });
});
