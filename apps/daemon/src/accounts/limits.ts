import type { AccountId, ProjectId } from '@10db/contracts';
import { getAccountRow } from '@10db/db';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';
import { movedCard, usageHighCard, type AccountCard } from './cards';
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
   * limit until usage drops back or the project moves.
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
  /** Per project, the `account:limit` keys past its threshold: in memory, so a restart may ask once more. */
  const crossed = new Map<ProjectId, Set<string>>();
  const isPaused = (id: AccountId): boolean => opts.pauses.pausedFor(id) !== null;
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
          const keys = crossed.get(project.id) ?? new Set<string>();
          const key = `${accountId}:${report.limitType ?? ''}`;
          if (report.utilization < project.usageHandoffAt) {
            keys.delete(key);
            continue;
          }
          if (keys.has(key)) continue;
          keys.add(key);
          crossed.set(project.id, keys);
        }
        const fallback = usableFallback(db, project, isPaused);
        if (fallback) {
          // At the threshold the lanes hand off first; at the limit itself nothing is left to do it with.
          opts.moves.move(project.id, fallback.id, {
            cause: MoveCause.UsageLimit,
            resetsAt: report.resetsAt,
            handOff: !atLimit,
          });
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
