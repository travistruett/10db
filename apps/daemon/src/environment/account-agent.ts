import { requireHarness, type Provider, type SupportedAccountKind } from '@10db/contracts';
import type { AccountRow } from '@10db/db';

/** What the adapters ask about an account: its kind (the credential) and the harness that runs it. */
export interface AccountAgent {
  readonly kind: SupportedAccountKind;
  readonly harness: Provider;
}

/** The kind and harness of an account a session runs on; a kind with no harness is refused with `requireHarness`'s message. */
export function accountAgentOf(
  account: Pick<AccountRow, 'kind' | 'label' | 'settings'>,
): AccountAgent {
  return { kind: account.kind, harness: requireHarness(account) };
}
