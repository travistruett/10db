import { AccountKind, AGENT_ACCOUNT_KINDS, type AgentAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nativeJudge } from './native-judge';
import type { LanePermissionMode } from './types';

const JUDGED: ReadonlySet<AgentAccountKind> = new Set([
  AccountKind.ClaudeSubscription,
  AccountKind.AnthropicApiKey,
  AccountKind.Bedrock,
]);

describe('nativeJudge', () => {
  it.each(
    AGENT_ACCOUNT_KINDS.flatMap((kind) =>
      (['auto', 'default', null] as const).map(
        (mode) => [kind, mode, JUDGED.has(kind) && mode === 'auto'] as const,
      ),
    ),
  )('%s in %s mode: %s', (kind, mode: LanePermissionMode | null, judged) => {
    expect(nativeJudge(kind, mode)).toBe(judged);
  });
});
