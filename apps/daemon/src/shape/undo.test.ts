import {
  ConflictError,
  InvalidError,
  PlanDraft,
  ShapeProposalState,
  ShapeState,
  TaskStatus,
  mintId,
  type DecisionId,
  type GoalId,
  type TaskId,
} from '@10db/contracts';
import {
  findRecords,
  getDecision,
  getPrinciple,
  getShape,
  insertWorkstream,
  listShapeLinks,
  listShapeProposals,
  listTasks,
  searchDecisions,
  searchPrinciples,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertProposals } from './convert';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { reconcileDraft } from './rounds';
import { removeDraftGoalOf, withdrawConvertedDecision, withdrawConvertedPrinciple } from './undo';

// Shape spec §11, Undo: Remove Draft Goal and Withdraw Decision, from the Proposed sidebar.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;

function convertedGoalAndDecision(): { goalId: GoalId; decisionId: DecisionId; taskIds: TaskId[] } {
  const m = c.say();
  const draft = PlanDraft.parse({
    goals: [
      {
        key: 'g',
        title: 'Goal',
        objective: 'Do it.',
        ceremony: 'direct',
        sourceMessageIds: [m],
        tasks: [{ key: 'g1', title: 'Only task', areas: ['api'], size: 'S' }],
      },
    ],
    records: [
      {
        key: 'dec',
        kind: 'decision',
        scope: 'project',
        question: 'Which queue?',
        choice: 'pg-boss',
        rationale: 'Fits',
        sourceMessageIds: [m],
      },
    ],
  });
  write((ctx) => reconcileDraft(ctx, c.shape.id, draft));
  const ids = listShapeProposals(c.store.db, c.shape.id).map((r) => r.id);
  const out = write((ctx) => convertProposals(ctx, c.shape.id, ids));
  if (!out.ok) throw new Error(out.errors.join('; '));
  const goal = must(
    out.results.find((r) => r.key === 'g'),
    'the goal',
  );
  return {
    goalId: must(goal.goalId, 'the goal id'),
    taskIds: [...goal.taskIds],
    decisionId: must(out.results.find((r) => r.key === 'dec')?.decisionId, 'the decision'),
  };
}

describe('Remove Draft Goal', () => {
  it('removes the goal and its tasks, and makes its proposal pending again', () => {
    const { goalId } = convertedGoalAndDecision();
    write((ctx) => {
      removeDraftGoalOf(ctx, c.shape.id, goalId);
    });
    expect(listTasks(c.store.db, c.project.id)).toEqual([]);
    const row = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'g');
    expect(row?.state).toBe(ShapeProposalState.Pending);
    expect(listShapeLinks(c.store.db, c.shape.id).map((l) => l.key)).toEqual(['dec']);
    expect(getShape(c.store.db, c.shape.id).state).toBe(ShapeState.Proposed);
  });

  it('lets the same proposal be converted anew', () => {
    const { goalId } = convertedGoalAndDecision();
    write((ctx) => {
      removeDraftGoalOf(ctx, c.shape.id, goalId);
    });
    const row = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'g');
    const out = write((ctx) =>
      convertProposals(ctx, c.shape.id, [row?.id ?? mintId('ShapeProposal')]),
    );
    expect(out).toMatchObject({ ok: true, createdNow: 1 });
    expect(listTasks(c.store.db, c.project.id)).toHaveLength(1);
  });

  it('refuses once a task has started, leaving everything as it was', () => {
    const { goalId, taskIds } = convertedGoalAndDecision();
    write((ctx) => insertWorkstream(ctx, taskIds[0] ?? mintId('Task')));
    expect(() => {
      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, goalId);
      });
    }).toThrow(/has started/);
    expect(listTasks(c.store.db, c.project.id).map((t) => t.status)).toEqual([TaskStatus.Open]);
    expect(listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'g')?.state).toBe(
      ShapeProposalState.Accepted,
    );
  });

  it('refuses a goal this conversation did not make', () => {
    expect(() => {
      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, mintId('Goal'));
      });
    }).toThrow(InvalidError);
  });
});

describe('Withdraw Principle', () => {
  const convertPrinciple = (key: string, statement: string, topicKey = 'tests.no-sleeps') => {
    const m = c.say('Never sleep in tests.');
    write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          records: [
            {
              key,
              kind: 'principle',
              scope: 'project',
              statement,
              topicKey,
              rationale: 'Sleeps make the suite flaky.',
              sourceMessageIds: [m],
            },
          ],
        }),
      ),
    );
    const row = must(
      listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key),
      'the proposal',
    );
    const out = write((ctx) => convertProposals(ctx, c.shape.id, [row.id]));
    if (!out.ok) throw new Error(out.errors.join('; '));
    return must(out.results[0]?.principleId, 'the principle');
  };

  it('withdraws the converted principle with a reason, and search forgets it', () => {
    const principleId = convertPrinciple('no-sleeps', 'Never sleep in tests');
    expect(searchPrinciples(c.store.db, c.project.id, 'sleep', 5)).toHaveLength(1);
    write((ctx) => {
      withdrawConvertedPrinciple(ctx, c.shape.id, principleId, 'We allow it now');
    });
    expect(getPrinciple(c.store.db, principleId)).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: 'We allow it now',
    });
    expect(searchPrinciples(c.store.db, c.project.id, 'sleep', 5)).toEqual([]);
    expect(findRecords(c.store.db, c.project.id, 'sleep', 5)).toEqual([]);
  });

  it('needs a reason, and refuses a principle this conversation did not write', () => {
    const principleId = convertPrinciple('no-sleeps', 'Never sleep in tests');
    expect(() => {
      write((ctx) => {
        withdrawConvertedPrinciple(ctx, c.shape.id, principleId, ' ');
      });
    }).toThrow(InvalidError);
    expect(() => {
      write((ctx) => {
        withdrawConvertedPrinciple(ctx, c.shape.id, mintId('Principle'), 'why');
      });
    }).toThrow(InvalidError);
  });

  it('refuses a principle a later one replaced', () => {
    const first = convertPrinciple('first', 'Never sleep in tests');
    convertPrinciple('second', 'Never sleep in tests, wait on a condition');
    expect(getPrinciple(c.store.db, first).state).toBe('superseded');
    expect(() => {
      write((ctx) => {
        withdrawConvertedPrinciple(ctx, c.shape.id, first, 'because');
      });
    }).toThrow(ConflictError);
  });
});

describe('Withdraw Decision', () => {
  it('withdraws the converted decision with a reason, and search forgets it', () => {
    const { decisionId } = convertedGoalAndDecision();
    expect(searchDecisions(c.store.db, c.project.id, 'queue', 5)).toHaveLength(1);
    write((ctx) => {
      withdrawConvertedDecision(ctx, c.shape.id, decisionId, 'We chose differently');
    });
    expect(getDecision(c.store.db, decisionId)).toMatchObject({
      withdrawnBy: 'builder',
      withdrawnReason: 'We chose differently',
    });
    expect(searchDecisions(c.store.db, c.project.id, 'queue', 5)).toEqual([]);
  });

  it('needs a reason, and refuses a decision this conversation did not write', () => {
    const { decisionId } = convertedGoalAndDecision();
    expect(() => {
      write((ctx) => {
        withdrawConvertedDecision(ctx, c.shape.id, decisionId, ' ');
      });
    }).toThrow(InvalidError);
    expect(() => {
      write((ctx) => {
        withdrawConvertedDecision(ctx, c.shape.id, mintId('Decision'), 'why');
      });
    }).toThrow(InvalidError);
  });

  it('refuses a decision that is not the head of its chain', () => {
    const { decisionId } = convertedGoalAndDecision();
    const m = c.say('Change of mind.');
    write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          records: [
            {
              key: 'dec2',
              kind: 'decision',
              scope: 'project',
              question: 'Which queue?',
              choice: 'BullMQ',
              rationale: 'Later',
              supersedes: decisionId,
              sourceMessageIds: [m],
            },
          ],
        }),
      ),
    );
    const next = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'dec2');
    write((ctx) => convertProposals(ctx, c.shape.id, [next?.id ?? mintId('ShapeProposal')]));
    expect(() => {
      write((ctx) => {
        withdrawConvertedDecision(ctx, c.shape.id, decisionId, 'because');
      });
    }).toThrow(ConflictError);
  });
});
