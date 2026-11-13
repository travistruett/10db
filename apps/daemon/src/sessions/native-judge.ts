import { AccountKind, type AgentAccountKind } from '@10db/contracts';
import type { LanePermissionMode } from './types';

/**
 * Whether the agent judges a lane's web calls itself: Claude Code's auto mode, whose classifier runs on a
 * Claude plan, the API and Bedrock (live check L2). A gateway was never checked, and Codex has no such
 * judge, so their web calls stay carded.
 */
export function nativeJudge(kind: AgentAccountKind, mode: LanePermissionMode | null): boolean {
  if (mode !== 'auto') return false;
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
    case AccountKind.Bedrock:
      return true;
    case AccountKind.Gateway:
    case AccountKind.CodexSignin:
      return false;
  }
}
