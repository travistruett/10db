import {
  CardDecider,
  ConflictError,
  DecisionRule,
  mintId,
  NotFoundError,
  type AccountId,
  type NoticeDecision,
  type ProjectId,
} from '@10db/contracts';
import { createTestStore, isRuleAsking, pageActivity, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { createActivityActions } from './activity-actions';
import { CardTier } from './card-tier';
import { postNotice } from './notice';

let close: () => void;
let store: Store;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function setup() {
  const project = seedProject(store);
  const state = createStateStore(store, createEventBus());
  const moves: { projectId: ProjectId; accountId: AccountId }[] = [];
  const actions = createActivityActions({
    state,
    moves: {
      moveProject: (projectId, accountId) => moves.push({ projectId, accountId }),
      forgetClaimDeadlock: () => undefined,
    },
  });
  /** Posts a rule-decided notice and returns its row's seq. */
  function decide(key: string, decision: NoticeDecision): number {
    state.write((ctx) => {
      postNotice(ctx, {
        tier: CardTier.Notice,
        projectId: project.id,
        taskId: null,
        key,
        tone: 'info',
        line: `Line ${key}`,
        body: `Body ${key}`,
        decision,
      });
    });
    const row = pageActivity(store.db, { project: project.id, pageSize: 50 }).rows.find(
      (entry) => entry.key === key,
    );
    if (row === undefined) throw new Error(`no row for ${key}`);
    return row.seq;
  }
  return { project, actions, moves, decide, rows: () => pageActivity(store.db, { pageSize: 50 }) };
}

describe('Activity actions', () => {
  it('undoes a move once, marks the row undone and posts a notice saying so', () => {
    const { project, actions, moves, decide, rows } = setup();
    const accountId = mintId('Account');
    const seq = decide('moved', {
      by: CardDecider.Rule,
      rule: DecisionRule.MoveBack,
      confidence: null,
      undo: {
        state: 'undoable',
        action: { kind: 'move_project', projectId: project.id, accountId },
      },
    });

    actions.undo(seq);

    expect(moves).toEqual([{ projectId: project.id, accountId }]);
    const page = rows();
    expect(page.rows.find((row) => row.seq === seq)?.undone).toBe(true);
    expect(page.rows.some((row) => row.line === 'Undone: Line moved')).toBe(true);
    expect(() => {
      actions.undo(seq);
    }).toThrow(ConflictError);
    expect(moves).toHaveLength(1);
  });

  it("refuses to undo a decision that can't be undone, and a row that is no decision", () => {
    const { actions, moves, decide } = setup();
    const seq = decide('stray', {
      by: CardDecider.Rule,
      rule: DecisionRule.StrayWrite,
      confidence: null,
      undo: { state: 'final', reason: '10db changed nothing' },
    });

    expect(() => {
      actions.undo(seq);
    }).toThrow(ConflictError);
    expect(() => {
      actions.undo(seq + 1000);
    }).toThrow(NotFoundError);
    expect(moves).toEqual([]);
  });

  it("turns a row's rule into a card for its project, and back, and the row says so", () => {
    const { project, actions, decide, rows } = setup();
    const seq = decide('stray', {
      by: CardDecider.Rule,
      rule: DecisionRule.StrayWrite,
      confidence: null,
      undo: { state: 'final', reason: '10db changed nothing' },
    });

    actions.askNextTime(seq, true);
    expect(isRuleAsking(store.db, project.id, DecisionRule.StrayWrite)).toBe(true);
    expect(rows().rows.find((row) => row.seq === seq)?.asking).toBe(true);

    actions.askNextTime(seq, false);
    expect(isRuleAsking(store.db, project.id, DecisionRule.StrayWrite)).toBe(false);
  });
});
