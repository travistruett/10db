import type { AccountId, ProjectId } from '@10db/contracts';
import { findOpenByFoldKey, getAccountRow } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import {
  accountFoldKey,
  MOVED_CARD,
  movedCard,
  USAGE_HIGH_CARD,
  usageHighCard,
  type AccountCard,
} from './cards';
import {
  MoveCause,
  moveTargets,
  projectsWithWork,
  usableFallback,
  type AccountMoves,
} from './moves';
import type { AccountPauses } from './pauses';
import type { UsageReport, UsageReports } from './usage-reports';

export interface AccountLimits {
  /**
   * A session on the account reported its usage limit. Each project on the account with work in
   * flight that is past its threshold hands its lanes off and moves to its fallback, or the builder is
   * asked; at the limit itself one with a fallback moves at once. A crossing acts once per project and
   * limit until the limit's window resets (another reset time, or a lower share with none reported)
   * or the project moves; a lower share from a concurrent session in the same window changes nothing.
   */
  usageReported(accountId: AccountId, report: UsageReport): void;
  /** The project moved: the crossings it met on the account it left no longer hold. */
  forget(projectId: ProjectId): void;
}

export function createAccountLimits(opts: {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly pauses: Pick<AccountPauses, 'pausedFor'>;
  readonly moves: Pick<AccountMoves, 'move'>;
  readonly reports: Pick<UsageReports, 'record'>;
}): AccountLimits {
  const db = opts.state.db;
  /**
   * Per project, the `account:limit` keys past its threshold, each with the reset time of the window it
   * crossed in (null when none was reported): in memory, so a restart may ask once more.
   */
  const crossed = new Map<ProjectId, Map<string, number | null>>();
  const isPaused = (id: AccountId): boolean => opts.pauses.pausedFor(id) !== null;
  /** Closes the project's open card of this kind on the account, so the next one is raised afresh. */
  const withdraw = (projectId: ProjectId, accountId: AccountId, about: string): void => {
    const open = findOpenByFoldKey(db, projectId, accountFoldKey(accountId, about));
    if (open) opts.inbox.withdraw(open.id);
  };
  const raise = (projectId: ProjectId, card: AccountCard): void => {
    opts.inbox.flag({
      projectId,
      workstreamId: null,
      title: card.title,
      body: card.body,
      detail: card.detail,
      foldKey: card.foldKey,
      ...(card.options ? { options: card.options } : {}),
    });
  };

  return {
    usageReported(accountId, report) {
      opts.reports.record(accountId, report);
      const account = getAccountRow(db, accountId);
      const atLimit = report.status === 'rejected';
      // An idle project neither moves nor is asked: its next work waits for the account's pause.
      for (const project of projectsWithWork(db, accountId)) {
        if (!atLimit) {
          if (report.utilization === null) continue;
          const marks = crossed.get(project.id) ?? new Map<string, number | null>();
          const key = `${accountId}:${report.limitType ?? ''}`;
          const window = report.resetsAt?.getTime() ?? null;
          const crossedBefore = marks.has(key);
          const markedWindow = marks.get(key) ?? null;
          const unknownWindow = window === null || markedWindow === null;
          if (report.utilization < project.usageHandoffAt) {
            // Usage only falls when its window resets: a different reset time, or none reported to say.
            if (crossedBefore && (unknownWindow || markedWindow !== window)) {
              marks.delete(key);
              withdraw(project.id, accountId, USAGE_HIGH_CARD);
            }
            continue;
          }
          if (crossedBefore && (unknownWindow || markedWindow === window)) {
            if (window !== null) marks.set(key, window);
            continue;
          }
          marks.set(key, window);
          crossed.set(project.id, marks);
        }
        const fallback = usableFallback(db, project, isPaused);
        if (fallback) {
          // At the threshold the lanes hand off first; at the limit itself nothing is left to do it with.
          opts.moves.move(project.id, fallback.id, {
            cause: MoveCause.UsageLimit,
            resetsAt: report.resetsAt,
            handOff: !atLimit,
          });
          // A card from an earlier move would absorb this one: each move says so afresh.
          withdraw(project.id, accountId, MOVED_CARD);
          raise(project.id, movedCard(project, account, fallback, report));
        } else if (!atLimit) {
          raise(
            project.id,
            usageHighCard(project, account, moveTargets(db, project, isPaused), report),
          );
        }
      }
    },
    forget(projectId) {
      crossed.delete(projectId);
    },
  };
}
