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
import {
  createTestStore,
  findOpenByFoldKey,
  isRuleAsking,
  listOpenByFoldKeyPrefix,
  pageActivity,
  seedProject,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from '../events';
import { createActivityActions } from './activity-actions';
import { CardTier } from './card-tier';
import { postNotice } from './notice';
import { applyRuleAsksAnswer, RuleAsksChoice, ruleAsksFoldKey } from './rule-asks-card';

let close: () => void;
let store: Store;
let now: Date;
beforeEach(() => {
  now = new Date('2026-11-01T09:00:00.000Z');
  ({ store, close } = createTestStore(() => now));
});
afterEach(() => {
  close();
});

function setup(restoreWorktree: () => Promise<void> = () => Promise.resolve()) {
  const project = seedProject(store);
  const state = createStateStore(store, createEventBus());
  const moves: { projectId: ProjectId; accountId: AccountId }[] = [];
  const actions = createActivityActions({
    state,
    moves: {
      moveProject: (projectId, accountId) => moves.push({ projectId, accountId }),
      forgetClaimDeadlock: () => undefined,
      restoreWorktree,
    },
  });
  /** Posts a rule-decided notice and returns its row's seq. */
  function decide(
    key: string,
    decision: NoticeDecision,
    projectId: ProjectId | null = project.id,
  ): number {
    state.write((ctx) => {
      postNotice(ctx, {
        tier: CardTier.Notice,
        projectId,
        taskId: null,
        key,
        tone: 'info',
        line: `Line ${key}`,
        body: `Body ${key}`,
        decision,
      });
    });
    const row = pageActivity(store.db, { pageSize: 50 }).rows.find((entry) => entry.key === key);
    if (row === undefined) throw new Error(`no row for ${key}`);
    return row.seq;
  }
  /** Posts a decision that can be undone, and returns its row's seq. */
  function undoable(key: string, projectId: ProjectId | null = project.id): number {
    return decide(
      key,
      {
        by: CardDecider.Rule,
        rule: DecisionRule.MoveBack,
        confidence: null,
        undo: {
          state: 'undoable',
          action: { kind: 'move_project', projectId: project.id, accountId: mintId('Account') },
        },
      },
      projectId,
    );
  }
  return {
    project,
    state,
    actions,
    moves,
    decide,
    undoable,
    rows: () => pageActivity(store.db, { pageSize: 50 }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Activity actions', () => {
  it('undoes a move once, marks the row undone and posts a notice saying so', async () => {
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

    await actions.undo(seq);

    expect(moves).toEqual([{ projectId: project.id, accountId }]);
    const page = rows();
    expect(page.rows.find((row) => row.seq === seq)?.undone).toBe(true);
    expect(page.rows.some((row) => row.line === 'Undone: Line moved')).toBe(true);
    await expect(actions.undo(seq)).rejects.toThrow(ConflictError);
    expect(moves).toHaveLength(1);
  });

  it('leaves a worktree row undoable when putting the worktree back fails', async () => {
    const { project, actions, decide, rows } = setup(() =>
      Promise.reject(new ConflictError('Something is already at the path')),
    );
    const seq = decide('removed', {
      by: CardDecider.Rule,
      rule: DecisionRule.MergedWorktree,
      confidence: null,
      undo: {
        state: 'undoable',
        action: {
          kind: 'restore_worktree',
          projectId: project.id,
          path: '/tmp/work',
          branch: 'hand/work',
          keptDir: null,
        },
      },
    });

    await expect(actions.undo(seq)).rejects.toThrow(ConflictError);

    expect(rows().rows.find((row) => row.seq === seq)?.undone).toBe(false);
  });

  it("refuses to undo a decision that can't be undone, and a row that is no decision", async () => {
    const { actions, moves, decide } = setup();
    const seq = decide('stray', {
      by: CardDecider.Rule,
      rule: DecisionRule.StrayWrite,
      confidence: null,
      undo: { state: 'final', reason: '10db changed nothing' },
    });

    await expect(actions.undo(seq)).rejects.toThrow(ConflictError);
    await expect(actions.undo(seq + 1000)).rejects.toThrow(NotFoundError);
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
    // The builder switched it themselves: no card says so.
    expect(listOpenByFoldKeyPrefix(store.db, 'rule-asks:')).toEqual([]);
  });

  describe('a rule undone twice in 30 days', () => {
    const rule = DecisionRule.MoveBack;

    it('asks in that project with one card, and a third undo raises no second', async () => {
      const { project, actions, undoable } = setup();
      await actions.undo(undoable('first'));
      expect(isRuleAsking(store.db, project.id, rule)).toBe(false);
      expect(listOpenByFoldKeyPrefix(store.db, 'rule-asks:')).toEqual([]);

      now = new Date(now.getTime() + 2 * DAY_MS);
      await actions.undo(undoable('second'));
      expect(isRuleAsking(store.db, project.id, rule)).toBe(true);
      const card = findOpenByFoldKey(store.db, project.id, ruleAsksFoldKey(project.id, rule));
      expect(card?.title).toContain('now asks you in');
      expect(card?.body).toContain('Line first (2026-11-01)');
      expect(card?.body).toContain('Line second (2026-11-03)');
      expect(card?.options.map((option) => option.label)).toEqual([
        RuleAsksChoice.Keep,
        RuleAsksChoice.Decide,
      ]);

      await actions.undo(undoable('third'));
      expect(listOpenByFoldKeyPrefix(store.db, 'rule-asks:')).toHaveLength(1);
    });

    it('does not switch when the undos are 31 days apart', async () => {
      const { project, actions, undoable } = setup();
      await actions.undo(undoable('first'));
      now = new Date(now.getTime() + 31 * DAY_MS);
      await actions.undo(undoable('second'));

      expect(isRuleAsking(store.db, project.id, rule)).toBe(false);
      expect(listOpenByFoldKeyPrefix(store.db, 'rule-asks:')).toEqual([]);
    });

    it("records nothing for an app's rows, which have no project", async () => {
      const { project, actions, undoable } = setup();
      await actions.undo(undoable('first', null));
      await actions.undo(undoable('second', null));
      // A later undo in the project is its first.
      await actions.undo(undoable('third'));

      expect(isRuleAsking(store.db, project.id, rule)).toBe(false);
      expect(listOpenByFoldKeyPrefix(store.db, 'rule-asks:')).toEqual([]);
    });

    it('decides again on Let 10db Decide Again, and counts afresh', async () => {
      const { project, state, actions, undoable } = setup();
      await actions.undo(undoable('first'));
      await actions.undo(undoable('second'));
      const card = findOpenByFoldKey(store.db, project.id, ruleAsksFoldKey(project.id, rule));
      if (card === undefined) throw new Error('no card');

      state.write((ctx) => {
        applyRuleAsksAnswer(ctx, card, { choice: RuleAsksChoice.Decide });
      });
      expect(isRuleAsking(store.db, project.id, rule)).toBe(false);

      await actions.undo(undoable('third'));
      expect(isRuleAsking(store.db, project.id, rule)).toBe(false);
      await actions.undo(undoable('fourth'));
      expect(isRuleAsking(store.db, project.id, rule)).toBe(true);
    });
  });
});
