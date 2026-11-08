import type { AccountId, InboxItemId, ProjectId } from '@10db/contracts';
import { findOpenByFoldKey, listAccounts, listProjects, type DbReader } from '@10db/db';
import type { Clock } from '../clock';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';

/** How long a lane's queued work leaves an account alone when no model profile exists for it yet. */
export const MODEL_LIST_WAIT_MS = 5 * 60_000;

export interface ModelListWait {
  /**
   * A lane found no model profile of the account's provider, so its step went back to the queue. The account's
   * queued work is left alone until profiles are rebuilt or `MODEL_LIST_WAIT_MS` passes, a card says so, and
   * the first hold of an account is logged.
   */
  hold(account: { readonly id: AccountId; readonly label: string }, projectId: ProjectId): void;
  /** Whether the scheduler should leave this account's queued work alone now. */
  holds(id: AccountId): boolean;
  /**
   * Profiles were rebuilt: every hold ends, so a lane tries again, and the card of an account that now has
   * profiles is closed. Asks for a scheduler tick when it ended a hold.
   */
  release(hasProfiles: (id: AccountId) => boolean): void;
}

interface Waiting {
  /** When the hold began; null once a rebuild has ended it. */
  since: Date | null;
  /** Whether this daemon has logged a hold of the account; a card taken on from an earlier one is not. */
  logged: boolean;
  readonly cards: Map<ProjectId, InboxItemId>;
}

const cardKey = (id: AccountId): string => `model-list-wait:${id}`;

export function createModelListWait(deps: {
  /** Read once, at creation, for the cards an earlier daemon left open. */
  readonly db: DbReader;
  readonly clock: Clock;
  readonly inbox: Pick<InboxService, 'flag' | 'resolve'>;
  readonly logger: Pick<Logger, 'info'>;
  /** A hold ended: the scheduler looks again. */
  readonly onReleased: () => void;
}): ModelListWait {
  const waiting = new Map<AccountId, Waiting>();
  // The holds lived in the earlier daemon's memory, but its cards are stored: they are taken on with no hold,
  // so the first rebuild closes those of an account that has profiles, and a lane that still finds none folds
  // its new card into the same one.
  const accounts = listAccounts(deps.db, { includeArchived: true });
  for (const project of listProjects(deps.db)) {
    for (const account of accounts) {
      const card = findOpenByFoldKey(deps.db, project.id, cardKey(account.id));
      if (card === undefined) continue;
      const entry = waiting.get(account.id) ?? {
        since: null,
        logged: false,
        cards: new Map<ProjectId, InboxItemId>(),
      };
      entry.cards.set(project.id, card.id);
      waiting.set(account.id, entry);
    }
  }
  return {
    hold(account, projectId) {
      let entry = waiting.get(account.id);
      if (entry === undefined) {
        entry = { since: null, logged: false, cards: new Map() };
        waiting.set(account.id, entry);
      }
      if (!entry.logged) {
        entry.logged = true;
        deps.logger.info(
          { accountId: account.id },
          'an account has no model profile yet, so its queued work waits for the model list',
        );
      }
      entry.since = deps.clock.now();
      entry.cards.set(
        projectId,
        deps.inbox.flag({
          projectId,
          workstreamId: null,
          title: `${account.label} is waiting for its model list`,
          body: `10db has no model profile for ${account.label} yet, so its queued work waits and is tried again when the model list arrives. This card closes by itself.`,
          foldKey: cardKey(account.id),
        }).id,
      );
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
        entry.since = null;
        if (!hasProfiles(id)) continue;
        for (const card of entry.cards.values())
          deps.inbox.resolve(card, 'The account’s model profiles are ready.');
        waiting.delete(id);
      }
      if (ended) deps.onReleased();
    },
  };
}
