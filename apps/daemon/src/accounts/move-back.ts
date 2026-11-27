import {
  CardDecider,
  DecisionRule,
  type AccountId,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import { getAccountRow, getProject, isRuleAsking, listMoveBacks, setMoveBack } from '@10db/db';
import { timerAt, type Clock, type Timer } from '../clock';
import type { StateStore } from '../events';
import { CardTier, type InboxService } from '../inbox';
import { moveBackCard } from './cards';
import { usageLimitEnd, type AccountPauses } from './pauses';
import type { UsageReports } from './usage-reports';

export interface MoveBack {
  /**
   * Arms the move back of a project that left an account for its usage limit: at its `moveBackAt`, or
   * after the default pause when nobody reported when the limit resets.
   */
  arm(projectId: ProjectId): void;
  /** Re-arms every move back after a restart; one that came due meanwhile happens (or raises its card) now. */
  restore(): void;
  stop(): void;
}

/**
 * Once the limit a project left for has reset, moves it back by itself when the limit moved it, and
 * otherwise asks whether to (accounts spec §6).
 */
export function createMoveBack(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  readonly pauses: Pick<AccountPauses, 'pausedFor'>;
  /** Usage the account the project left still reports. */
  readonly reports: Pick<UsageReports, 'stillHigh'>;
  /** How long a usage limit with no reported reset lasts: the runtime's default pause. */
  readonly defaultPauseMs: number;
  /**
   * Moves a project back to the account it left, which it does by itself for a move its usage limit
   * caused (`AccountMoves.move` with `MoveCause.MoveBack`).
   */
  readonly back: (projectId: ProjectId, to: AccountId) => void;
}): MoveBack {
  const db = opts.state.db;
  const timers = new Map<ProjectId, Timer>();

  const whenToAsk = (project: ProjectDto): Date =>
    project.moveBackAt === null
      ? new Date(opts.clock.now().getTime() + opts.defaultPauseMs)
      : new Date(project.moveBackAt);

  function schedule(projectId: ProjectId, at: Date): void {
    timers.get(projectId)?.cancel();
    if (at <= opts.clock.now()) {
      timers.delete(projectId);
      due(projectId);
      return;
    }
    timers.set(
      projectId,
      timerAt(opts.clock, at, () => {
        timers.delete(projectId);
        due(projectId);
      }),
    );
  }

  function due(projectId: ProjectId): void {
    const project = getProject(db, projectId);
    if (project.movedFromAccountId === null) return;
    const from = getAccountRow(db, project.movedFromAccountId);
    if (from.archived || from.id === project.accountId) {
      opts.state.write((ctx) => setMoveBack(ctx, projectId, null));
      return;
    }
    const held = opts.pauses.pausedFor(from.id);
    if (held) {
      // The account it left is still paused: its usage limit met again after the move, its monthly cap
      // or a refusal. Ask when that pause ends, or after the default pause when it has no end.
      const limitEnds = usageLimitEnd(held);
      if (limitEnds !== null)
        opts.state.write((ctx) =>
          setMoveBack(ctx, projectId, {
            accountId: from.id,
            at: limitEnds.toISOString(),
            automatic: project.moveBackAutomatic,
          }),
        );
      schedule(projectId, held.until ?? new Date(opts.clock.now().getTime() + opts.defaultPauseMs));
      return;
    }
    // A session on the account it left still reports usage past the project's threshold: ask later.
    const high = opts.reports.stillHigh(from.id, project.usageHandoffAt);
    if (high !== null) {
      schedule(projectId, high);
      return;
    }
    // A builder who set this rule to ask is asked, as a move the builder made by hand is.
    const asking = isRuleAsking(db, projectId, DecisionRule.MoveBack);
    if (project.moveBackAutomatic && !asking) {
      // The limit moved it, so the limit's end moves it back: no card, no builder. A move the daemon
      // can't make (a refusal in the move itself) is asked about instead of lost or thrown at a timer.
      let moved = false;
      try {
        opts.back(projectId, from.id);
        moved = true;
      } catch {
        // Falls through to the card.
      }
      if (moved) {
        // The move is in Activity with the Undo that puts the project back where it was.
        opts.inbox.notice({
          tier: CardTier.Notice,
          projectId,
          taskId: null,
          key: `move-back:${projectId}`,
          tone: 'info',
          line: `${project.name} moved back to ${from.label}`,
          body: `${from.label}'s usage limit reset, so 10db moved ${project.name} back to it from ${getAccountRow(db, project.accountId).label}. Each lane's next session runs there from its latest handoff.`,
          decision: {
            by: CardDecider.Rule,
            rule: DecisionRule.MoveBack,
            confidence: null,
            undo: {
              state: 'undoable',
              action: { kind: 'move_project', projectId, accountId: project.accountId },
            },
          },
        });
        return;
      }
    }
    const card = moveBackCard(project, from, getAccountRow(db, project.accountId));
    opts.inbox.flag({
      projectId,
      workstreamId: null,
      tier: card.tier,
      urgency: card.urgency,
      closesWhen: card.closesWhen,
      decision: card.decision,
      title: card.title,
      body: card.body,
      detail: card.detail,
      foldKey: card.foldKey,
      ...(card.options ? { options: card.options } : {}),
    });
  }

  return {
    arm(projectId) {
      const project = getProject(db, projectId);
      if (project.movedFromAccountId !== null) schedule(projectId, whenToAsk(project));
    },
    restore() {
      for (const project of listMoveBacks(db)) schedule(project.id, whenToAsk(project));
    },
    stop() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
