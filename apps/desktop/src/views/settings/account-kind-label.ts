import { AccountKind, type SupportedAccountKind } from '@10db/contracts';

/** How each account kind reads in the UI. */
export const ACCOUNT_KIND_LABEL: Readonly<Record<SupportedAccountKind, string>> = {
  [AccountKind.ClaudeSubscription]: 'Claude Subscription',
  [AccountKind.AnthropicApiKey]: 'Anthropic API key',
  [AccountKind.Bedrock]: 'Amazon Bedrock',
  [AccountKind.CodexSignin]: 'ChatGPT plan',
  [AccountKind.OpenRouter]: 'OpenRouter key',
};
