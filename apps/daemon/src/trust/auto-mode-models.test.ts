import type { AgentAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { autoModeRuns } from './auto-mode-models';

describe('autoModeRuns', () => {
  it.each<[AgentAccountKind, string | null, boolean]>([
    ['claude_subscription', 'claude-opus-5-5', true],
    ['claude_subscription', 'claude-sonnet-4-6', true],
    ['claude_subscription', 'claude-sonnet-4-5', false],
    ['claude_subscription', 'claude-sonnet-4-20250514', false],
    ['claude_subscription', 'claude-haiku-5-5', true],
    ['claude_subscription', 'claude-haiku-4-5', false],
    ['claude_subscription', 'claude-fable-5-1', true],
    ['claude_subscription', 'sonnet', true],
    ['claude_subscription', 'opus[1m]', true],
    ['claude_subscription', 'gpt-5', false],
    ['claude_subscription', null, true],
    ['anthropic_api_key', 'claude-opus-4-6', true],
    ['bedrock', 'us.anthropic.claude-sonnet-5-5', true],
    ['bedrock', 'us.anthropic.claude-opus-4-6-v1:0', false],
    ['bedrock', 'global.anthropic.claude-opus-4-7', true],
    ['bedrock', 'us.anthropic.claude-sonnet-4-6', false],
    ['bedrock', null, false],
    ['bedrock', 'haiku', false],
    ['bedrock', 'us.anthropic.claude-fable-5-1', true],
    ['gateway', 'claude-opus-5-5', false],
    ['codex_signin', 'gpt-5.5', false],
  ])('%s on %s: %s', (kind, model, runs) => {
    expect(autoModeRuns(kind, model)).toBe(runs);
  });
});
