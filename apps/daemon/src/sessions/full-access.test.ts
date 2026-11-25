import { AccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { fullAccessSettings, fullAccessEnv } from './full-access';
import { fullAccessOptions } from './claude-query-options';

const profile = {
  kind: 'explore',
  systemPrompt: 'prompt',
  tools: [],
  allowedTools: [],
  disallowedTools: [],
  agents: {},
  setup: { instructions: null, plugins: [] },
  autoMode: null,
} as const;
const base = { autoModeRuns: true, apiKeyHelper: null, defaultConfigDir: true, keyInEnv: false };

describe('a Full access chat on each kind of account', () => {
  it('runs in auto mode unless a key is in the env, reads an API key by helper and relays on a second folder', () => {
    expect(fullAccessSettings({ ...base, kind: AccountKind.ClaudeSubscription })).toEqual({
      permissionMode: 'auto',
      apiKeyHelper: null,
      scrub: false,
      ownSetup: true,
    });
    const keyed = fullAccessSettings({
      ...base,
      kind: AccountKind.AnthropicApiKey,
      apiKeyHelper: '/usr/bin/security find-generic-password -s 10db -a x -w',
    });
    expect(keyed).toMatchObject({ permissionMode: 'auto', scrub: false });
    expect(fullAccessEnv({ ANTHROPIC_API_KEY: 'sk-secret', PATH: '/bin' }, keyed)).toEqual({
      PATH: '/bin',
    });
    expect(fullAccessOptions(profile, keyed).settings).toMatchObject({
      apiKeyHelper: keyed.apiKeyHelper,
    });
    const bedrockKey = fullAccessSettings({ ...base, kind: AccountKind.Bedrock, keyInEnv: true });
    expect(bedrockKey).toMatchObject({ permissionMode: 'default', scrub: true });
    expect(fullAccessOptions(profile, bedrockKey)).toMatchObject({
      permissionMode: 'default',
      sandboxEnv: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
    });
    expect(
      fullAccessSettings({
        ...base,
        kind: AccountKind.ClaudeSubscription,
        defaultConfigDir: false,
      }),
    ).toMatchObject({ ownSetup: false });
  });
});
