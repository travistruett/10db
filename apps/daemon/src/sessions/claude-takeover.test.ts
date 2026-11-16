import { describe, expect, it } from 'vitest';
import type { TakeoverLaunch } from '../environment';
import { claudeTakeoverCommand } from './claude-takeover';
import { SECRET_VARIABLES } from '../environment';
import { TakeoverRefusedError, type TakeoverSpec } from './takeover-command';

// Sessions spec §7.5: Claude's column of the command table, one row per account kind.

const NONE: TakeoverLaunch = {
  set: {},
  unset: ['ANTHROPIC_API_KEY', 'CLAUDECODE'],
  unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'CLAUDE_CODE_USE_', 'TENDB_'],
  keychain: [],
  apiKeyHelperAccount: null,
  scrub: false,
  model: 'claude-sonnet-5-5',
};

function spec(launch: TakeoverLaunch, over: Partial<TakeoverSpec> = {}): TakeoverSpec {
  return {
    kind: 'claude_subscription',
    binary: '/pinned/claude',
    cwd: '/work/repo',
    providerSessionId: 'abc-123',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    launch,
    pluginDirs: ['/setup/plugins/one', '/setup/plugins/two'],
    instructionsFile: '/data/takeover/instructions.md',
    mcpConfigFile: '/data/takeover/mcp.json',
    codexServers: [],
    sealedEnvFile: null,
    web: true,
    ...over,
  };
}

const HELPER = "/usr/bin/security find-generic-password -s 10db -a 'account:k' -w";

describe('claudeTakeoverCommand', () => {
  it.each<{
    name: string;
    launch: TakeoverLaunch;
    set: Record<string, string>;
    helper: boolean;
  }>([
    {
      name: 'a plan',
      launch: { ...NONE, set: { CLAUDE_CONFIG_DIR: '/d/claude' } },
      set: { CLAUDE_CONFIG_DIR: '/d/claude' },
      helper: false,
    },
    {
      name: 'an API key',
      launch: {
        ...NONE,
        set: { CLAUDE_CONFIG_DIR: '/d/claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
        apiKeyHelperAccount: 'account:k',
      },
      set: { CLAUDE_CONFIG_DIR: '/d/claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      helper: true,
    },
    {
      name: 'a Bedrock key',
      launch: {
        ...NONE,
        set: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1' },
        keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }],
        scrub: true,
      },
      set: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'eu-central-1',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      },
      helper: false,
    },
    {
      name: 'a Bedrock profile',
      launch: { ...NONE, set: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'client-c' } },
      set: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'client-c' },
      helper: false,
    },
    {
      name: 'a gateway',
      launch: {
        ...NONE,
        set: { ANTHROPIC_BASE_URL: 'https://gw.example' },
        apiKeyHelperAccount: 'account:k',
      },
      set: { ANTHROPIC_BASE_URL: 'https://gw.example' },
      helper: true,
    },
  ])('resumes the chat isolated on $name', ({ launch, set, helper }) => {
    const command = claudeTakeoverCommand(spec(launch));
    expect(command.cwd).toBe('/work/repo');
    expect(command.set).toEqual({ ...set, DISABLE_AUTOUPDATER: '1' });
    expect(command.unset).toEqual(launch.unset);
    expect(command.unsetPrefixes).toEqual(launch.unsetPrefixes);
    expect(command.keychain).toEqual(launch.keychain);
    expect(command.sources).toEqual([]);
    const settings = command.argv[command.argv.indexOf('--settings') + 1];
    if (typeof settings !== 'string') throw new Error('--settings has no value');
    expect(JSON.parse(settings)).toEqual({
      effortLevel: 'high',
      ...(helper ? { apiKeyHelper: HELPER } : {}),
    });
    expect(command.argv).toEqual([
      '/pinned/claude',
      '--resume',
      'abc-123',
      '--setting-sources',
      '',
      '--settings',
      settings,
      '--model',
      'claude-sonnet-5-5',
      '--strict-mcp-config',
      '--mcp-config',
      '/data/takeover/mcp.json',
      '--plugin-dir',
      '/setup/plugins/one',
      '--plugin-dir',
      '/setup/plugins/two',
      '--append-system-prompt',
      { prefix: '', file: '/data/takeover/instructions.md' },
    ]);
  });

  it('puts no credential variable in the command, whichever way the account reads its key', () => {
    for (const launch of [
      { ...NONE, apiKeyHelperAccount: 'account:k' },
      { ...NONE, keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }] },
    ]) {
      const command = claudeTakeoverCommand(spec(launch));
      for (const name of SECRET_VARIABLES) expect(command.set).not.toHaveProperty(name);
      expect(JSON.stringify(command.argv)).not.toMatch(/sk-|AUTH_TOKEN|BEARER_TOKEN/);
    }
  });

  it('leaves out the servers, plugins and instructions the chat has none of', () => {
    const { argv } = claudeTakeoverCommand(
      spec(NONE, { mcpConfigFile: null, pluginDirs: [], instructionsFile: null }),
    );
    expect(argv).toContain('--strict-mcp-config');
    for (const flag of ['--mcp-config', '--plugin-dir', '--append-system-prompt'])
      expect(argv).not.toContain(flag);
  });

  it.each(['', '--help', 'a b', 'a;b', "a'b", 'x'.repeat(129)])(
    'refuses the session id %j',
    (id) => {
      expect(() => claudeTakeoverCommand(spec(NONE, { providerSessionId: id }))).toThrow(
        TakeoverRefusedError,
      );
    },
  );
});
