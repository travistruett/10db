import {
  accountDisplayName,
  AccountKind,
  type AccountDto,
  type SupportedAccountKind,
} from '@10db/contracts';

/** How each account kind reads in the UI. */
export const ACCOUNT_KIND_LABEL: Readonly<Record<SupportedAccountKind, string>> = {
  [AccountKind.ClaudeSubscription]: 'Claude subscription',
  [AccountKind.AnthropicApiKey]: 'Anthropic API key',
  [AccountKind.Bedrock]: 'Amazon Bedrock',
  [AccountKind.Gateway]: 'Gateway',
};

/**
 * The accounts a project can run on: every one not archived, by label, recorded identity and kind,
 * as in "Claude plan · you@example.com (Claude subscription)".
 */
export function accountOptions(
  accounts: readonly AccountDto[],
): { value: string; label: string }[] {
  return accounts
    .filter((a) => !a.archived)
    .map((a) => ({
      value: a.id,
      label: `${accountDisplayName(a)} (${ACCOUNT_KIND_LABEL[a.kind]})`,
    }));
}
