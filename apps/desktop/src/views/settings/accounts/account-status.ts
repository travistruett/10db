import { AccountKind, needsSecret, type AccountDto } from '@10db/contracts';

export const AccountStatus = {
  Ready: 'ready',
  NeedsSignIn: 'needs_sign_in',
  NeedsSecret: 'needs_secret',
  Archived: 'archived',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ACCOUNT_STATUS_LABEL: Readonly<Record<AccountStatus, string>> = {
  [AccountStatus.Ready]: 'Ready',
  [AccountStatus.NeedsSignIn]: 'Needs sign-in',
  [AccountStatus.NeedsSecret]: 'Needs a secret',
  [AccountStatus.Archived]: 'Archived',
};

/**
 * Whether the account can start a session, from what the DTO carries. It mirrors the rule the
 * daemon enforces in `apps/daemon/src/accounts/readiness.ts`; an archived account is archived
 * whatever else is missing.
 */
export function accountStatus(account: AccountDto): AccountStatus {
  if (account.archived) return AccountStatus.Archived;
  if (account.kind === AccountKind.ClaudeSubscription && account.expectedIdentity === null)
    return AccountStatus.NeedsSignIn;
  if (needsSecret(account.kind, account.settings) && !account.secretSet)
    return AccountStatus.NeedsSecret;
  return AccountStatus.Ready;
}
