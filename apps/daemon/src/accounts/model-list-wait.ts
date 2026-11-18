import { StatusKind, type AccountId } from '@10db/contracts';
import { findOpenByFoldKey, listAccounts, listProjects, type DbReader } from '@10db/db';
import type { Clock } from '../clock';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import type { StatusService } from '../status';

/** How long a lane's queued work leaves an account alone when no model profile exists for it yet. */
export const MODEL_LIST_WAIT_MS = 5 * 60_000;

export interface ModelListWait {
  /**
   * A lane found no model profile of the account's provider, so its step went back to the queue. The account's
   * queued work is left alone until profiles are rebuilt or `MODEL_LIST_WAIT_MS` passes, the status line says
   * so, and the first hold of an account is logged.
   */
  hold(account: { readonly id: AccountId; readonly label: string }): void;
  /** Whether the scheduler should leave this account's queued work alone now. */
  holds(id: AccountId): boolean;
  /**
   * Profiles were rebuilt: every hold ends, so a lane tries again, and one that still finds none holds again.
   * Asks for a scheduler tick when it ended a hold.
   */
  release(hasProfiles: (id: AccountId) => boolean): void;
}

interface Waiting {
  /** When the hold began; null once a rebuild has ended it. */
  since: Date | null;
}

const statusKey = (id: AccountId): string => `model-list-wait:${id}`;

export function createModelListWait(deps: {
  /** Read once, at creation, for the cards an earlier version left open. */
  readonly db: DbReader;
  readonly clock: Clock;
  readonly inbox: Pick<InboxService, 'withdraw'>;
  readonly status: Pick<StatusService, 'hold' | 'release'>;
  readonly logger: Pick<Logger, 'info'>;
  /** A hold ended: the scheduler looks again. */
  readonly onReleased: () => void;
}): ModelListWait {
  const waiting = new Map<AccountId, Waiting>();
  // A card an earlier version raised for this wait and left open would say for good that an account waits.
  for (const project of listProjects(deps.db)) {
    for (const account of listAccounts(deps.db, { includeArchived: true })) {
      const card = findOpenByFoldKey(deps.db, project.id, statusKey(account.id));
      if (card !== undefined) deps.inbox.withdraw(card.id);
    }
  }
  const logged = new Set<AccountId>();
  return {
    hold(account) {
      if (!logged.has(account.id)) {
        logged.add(account.id);
        deps.logger.info(
          { accountId: account.id },
          'an account has no model profile yet, so its queued work waits for the model list',
        );
      }
      waiting.set(account.id, { since: deps.clock.now() });
      deps.status.hold(statusKey(account.id), {
        kind: StatusKind.ModelListWait,
        line: `${account.label} is waiting for its model list`,
        details: `10db has no model profile for ${account.label} yet, so its queued work waits and is tried again when the model list arrives.`,
        culprits: [],
      });
    },
    holds(id) {
      const since = waiting.get(id)?.since;
      return (
        since !== undefined &&
        since !== null &&
        deps.clock.now().getTime() - since.getTime() < MODEL_LIST_WAIT_MS
      );
    },
    release(hasProfiles) {
      let ended = false;
      for (const [id, entry] of waiting) {
        if (entry.since !== null) ended = true;
        deps.status.release(statusKey(id));
        if (hasProfiles(id)) waiting.delete(id);
        else entry.since = null;
      }
      if (ended) deps.onReleased();
    },
  };
}
