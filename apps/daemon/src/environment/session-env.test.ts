import { describe, expect, it } from 'vitest';
import { BILLING_SWITCH_VARS, NESTED_SESSION_VARS, stripBillingSwitches } from './index';

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
  CLAUDE_CONFIG_DIR: '/h/b/.claude-other',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-zshrc',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SSE_PORT: '5555',
  CLAUDE_PROJECT_DIR: '/h/b/Projects/other',
  TENDB_DATA_DIR: '/data',
  TENDB_FAKE_SCRIPTS: '/scripts.json',
};

describe('stripBillingSwitches', () => {
  it('drops every named billing switch and nested-session marker, the provider families and the 10db variables', () => {
    const env = stripBillingSwitches(BASE);
    for (const name of [...BILLING_SWITCH_VARS, ...NESTED_SESSION_VARS])
      expect(env).not.toHaveProperty(name);
    expect(
      Object.keys(env).filter((name) => /^(TENDB_|ANTHROPIC_DEFAULT_|CLAUDE_CODE_USE_)/.test(name)),
    ).toEqual([]);
    expect(env).toEqual({
      PATH: BASE['PATH'],
      HOME: '/h/b',
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'dev',
    });
  });

  it.each([
    ['a billing switch', 'ANTHROPIC_API_KEY'],
    ['a config directory', 'CLAUDE_CONFIG_DIR'],
    ['an OAuth token', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['a provider family member', 'CLAUDE_CODE_USE_MANTLE'],
    ['a nested-session marker', 'CLAUDECODE'],
    ['a 10db variable', 'TENDB_DATA_DIR'],
    ['a git repository variable', 'GIT_DIR'],
  ])('drops %s', (_name, variable) => {
    const env = stripBillingSwitches({ ...BASE, [variable]: 'x', GIT_DIR: '/elsewhere/.git' });
    expect(env).not.toHaveProperty(variable);
    expect(env).toMatchObject({ PATH: BASE['PATH'], HOME: '/h/b', AWS_PROFILE: 'dev' });
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
    const env = stripBillingSwitches({ ...BASE, ...repositoryVariables, ...kept });
    for (const name of Object.keys(repositoryVariables)) expect(env).not.toHaveProperty(name);
    expect(env).toMatchObject(kept);
  });

  it('does not modify the captured base', () => {
    const before = { ...BASE };
    stripBillingSwitches(BASE);
    expect(BASE).toEqual(before);
  });
});
