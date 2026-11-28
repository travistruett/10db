import {
  ConflictError,
  NotFoundError,
  type AccountId,
  type DecisionRule,
  type NoticeDecision,
  type NoticePostedData,
  type ProjectId,
  type UndoAction,
  type WorkstreamId,
} from '@10db/contracts';
import { getPostedNotice, isRuleAsking, markRowUndone, setRuleAsking, undoneRows } from '@10db/db';
import type { StateStore } from '../events';
import { CardTier } from './card-tier';
import { postNotice } from './notice';

/** What the builder does to an Activity row that reports a decision 10db made for them. */
export interface ActivityActions {
  /**
   * Takes the row's decision back where it can be: a `NotFoundError` for a row that is no decision, a
   * `ConflictError` for one that can't be undone or was already undone. The row's rule then stays as it
   * was; Undo undoes one move, Ask Me Next Time changes the rule. A move that fails marks nothing.
   */
  undo(seq: number): Promise<void>;
  /**
   * Sets the row's rule to ask (or back to deciding) in the row's project, so the rule's next
   * occurrence is a card. A `NotFoundError` for a row that is no decision of a project.
   */
  askNextTime(seq: number, asking: boolean): void;
}

/** A decision's row, as the builder acts on it. */
interface DecidedRow {
  readonly data: NoticePostedData;
  readonly decision: NoticeDecision;
}

/** Performs each kind of undoable move; the daemon wires the ones it owns. */
export interface UndoMoves {
  moveProject(projectId: ProjectId, accountId: AccountId): void;
  /** Forgets the deadlock record of the pair, leaving every claim where it is. */
  forgetClaimDeadlock(a: WorkstreamId, b: WorkstreamId): void;
  /** Makes a removed hand-made worktree again; a `ConflictError` when its path or branch is not as it was. */
  restoreWorktree(action: Extract<UndoAction, { kind: 'restore_worktree' }>): Promise<void>;
}

export function createActivityActions(deps: {
  readonly state: StateStore;
  readonly moves: UndoMoves;
}): ActivityActions {
  const db = deps.state.db;

  function decidedRow(seq: number): DecidedRow {
    const notice = getPostedNotice(db, seq);
    if (notice?.data.decision === undefined) {
      throw new NotFoundError('Activity decision', String(seq));
    }
    return { data: notice.data, decision: notice.data.decision };
  }

  /** Each kind of `UndoAction` is one move; a move that fails throws and the row stays as it was. */
  async function perform(action: UndoAction): Promise<void> {
    switch (action.kind) {
      case 'move_project':
        deps.moves.moveProject(action.projectId, action.accountId);
        return;
      case 'forget_claim_deadlock':
        deps.moves.forgetClaimDeadlock(action.a, action.b);
        return;
      case 'restore_worktree':
        await deps.moves.restoreWorktree(action);
        return;
    }
  }

  return {
    async undo(seq) {
      const { data, decision } = decidedRow(seq);
      if (decision.undo.state === 'final') {
        throw new ConflictError(`This decision can't be undone now: ${decision.undo.reason}`);
      }
      if (undoneRows(db).has(seq)) throw new ConflictError('This decision was already undone');
      await perform(decision.undo.action);
      deps.state.write((ctx) => {
        markRowUndone(ctx, seq);
        postNotice(ctx, {
          tier: CardTier.Notice,
          projectId: data.projectId,
          taskId: data.taskId,
          key: `undo:${String(seq)}`,
          tone: 'info',
          line: `Undone: ${data.line}`,
          body: `You undid this decision from Activity.\n\n${data.body}`,
        });
      });
    },
    askNextTime(seq, asking) {
      const { data, decision } = decidedRow(seq);
      const { projectId } = data;
      if (projectId === null) {
        throw new NotFoundError('Activity decision of a project', String(seq));
      }
      const rule: DecisionRule = decision.rule;
      if (isRuleAsking(db, projectId, rule) === asking) return;
      deps.state.write((ctx) => {
        setRuleAsking(ctx, projectId, rule, asking);
      });
    },
  };
}
