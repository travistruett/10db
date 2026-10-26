import { AccountKind, AccountProblem, type AccountRefusal } from '@10db/contracts';
import type { AccountRow } from '@10db/db';

/** Why the account can't start a session yet, from its row alone; null when it may try. */
export function unready(account: AccountRow): AccountRefusal | null {
  if (account.kind === AccountKind.ClaudeSubscription && account.expectedIdentity === null)
    return {
      problem: AccountProblem.Unconfirmed,
      message: `Account "${account.label}" has no confirmed identity yet`,
      seenIdentity: null,
    };
  if (account.secretRef !== null && account.secretFingerprint === null)
    return {
      problem: AccountProblem.SecretMissing,
      message: `Account "${account.label}" has no secret set through 10db`,
      seenIdentity: null,
    };
  return null;
}
