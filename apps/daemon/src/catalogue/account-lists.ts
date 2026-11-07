import type { AccountId, SupportedAccountKind } from '@10db/contracts';
import { replaceAccountModels } from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { SeenAccount } from '../sessions';
import { offerFromList } from './account-offer';
import { reconcileProfiles } from './profiles';
import type { Catalogue } from './source';

export interface AccountLists {
  /**
   * Stores the list a probe read for the account and, when it differs from the stored one, builds profiles from
   * it. A probe that read no list leaves the stored list and its time alone. The caller has already checked the
   * account: a signed-out process still answers a listing, so an unchecked list proves nothing. It never throws.
   */
  record(
    account: { readonly id: AccountId; readonly kind: SupportedAccountKind },
    seen: SeenAccount,
  ): void;
}

export function createAccountLists(deps: {
  readonly state: StateStore;
  /** The catalogue in use; null when there is none, and then nothing can be joined or stored. */
  readonly catalogue: () => Catalogue | null;
  readonly logger: Logger;
}): AccountLists {
  return {
    record(account, seen) {
      const catalogue = deps.catalogue();
      if (seen.models === undefined || catalogue === null) return;
      const models = seen.models;
      try {
        deps.state.write((ctx) => {
          const changed = replaceAccountModels(
            ctx,
            account.id,
            offerFromList(account.kind, models, catalogue),
          );
          if (changed) reconcileProfiles(ctx, catalogue);
        });
      } catch (error) {
        deps.logger.warn(
          { accountId: account.id, err: error instanceof Error ? error.name : 'error' },
          'could not store the models an account lists; keeping the last list',
        );
      }
    },
  };
}
