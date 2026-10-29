import { AccountKind, type SupportedAccountKind } from '@10db/contracts';

/** How each account kind reads in the UI. */
export const ACCOUNT_KIND_LABEL: Readonly<Record<SupportedAccountKind, string>> = {
  [AccountKind.ClaudeSubscription]: 'Claude subscription',
  [AccountKind.AnthropicApiKey]: 'Anthropic API key',
  [AccountKind.Bedrock]: 'Amazon Bedrock',
  [AccountKind.Gateway]: 'Gateway',
};
