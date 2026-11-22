import { describe, expect, it } from 'vitest';
import type { TakeoverLaunch } from '../environment';
import { claudeTakeoverCommand } from './claude-takeover';
import { SECRET_VARIABLES } from '../environment';
import type { TakeoverSpec } from './takeover-command';

// Sessions spec §7.5: Claude's column of the command table.

const NONE: TakeoverLaunch = {
  set: {},
  unset: ['ANTHROPIC_API_KEY', 'CLAUDECODE'],
  unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'CLAUDE_CODE_USE_', 'TENDB_'],
  keychain: [],
  apiKeyHelperAccount: null,
  scrub: false,
  model: 'claude-sonnet-5-5',
};

function spec(launch: TakeoverLaunch): TakeoverSpec {
  return {
    kind: 'claude_subscription',
    harness: 'claude',
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
  };
}

describe('claudeTakeoverCommand', () => {
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
});
