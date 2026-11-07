import { AccountKind, type SupportedAccountKind } from '@10db/contracts';
import { SHAPE_AGENT_MODELS } from './confinement';

/**
 * The models a Plan session may name on an agent it launches. Claude Code's Agent tool takes its own
 * aliases, which resolve to the current models on a subscription or an API key. On Bedrock and a gateway they
 * resolve to older models than the account lists, and a ChatGPT account has no Agent tool, so an agent there
 * runs on the session's model.
 */
export function shapeAgentModels(kind: SupportedAccountKind): readonly string[] {
  switch (kind) {
    case AccountKind.ClaudeSubscription:
    case AccountKind.AnthropicApiKey:
      return SHAPE_AGENT_MODELS;
    case AccountKind.Bedrock:
    case AccountKind.Gateway:
    case AccountKind.CodexSignin:
      return [];
  }
}
