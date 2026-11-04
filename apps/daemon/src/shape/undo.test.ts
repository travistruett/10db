import {
  ConflictError,
  InvalidError,
  NotFoundError,
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
  getGoal,
  getPrinciple,
  getShape,
  insertWorkstream,
  listShapeAttachments,
  listShapeLinks,
  listShapeProposals,
  listShapeQuestions,
  listTasks,
  searchDecisions,
  searchPrinciples,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attach } from './attach';
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

  it('removes a goal that has an eval, and the eval follows the goal when converted anew', () => {
    const m = c.say();
    const draft = PlanDraft.parse({
      goals: [
        {
          key: 'g',
          title: 'Goal',
          objective: 'Do it.',
          ceremony: 'direct',
          sourceMessageIds: [m],
          eval: {
            objective: 'Fewer clicks',
            baseline: ['12 clicks today'],
            models: ['claude-opus-5-5'],
            constraints: ['No new dependencies'],
          },
          tasks: [{ key: 'g1', title: 'Only task', areas: ['api'], size: 'S' }],
        },
      ],
    });
    write((ctx) => reconcileDraft(ctx, c.shape.id, draft));
    const ids = listShapeProposals(c.store.db, c.shape.id).map((r) => r.id);
    const first = write((ctx) => convertProposals(ctx, c.shape.id, ids));
    if (!first.ok) throw new Error(first.errors.join('; '));
    const goalId = must(first.results.find((r) => r.key === 'g')?.goalId, 'the goal id');
    expect(listShapeAttachments(c.store.db, c.shape.id).map((a) => a.goalId)).toEqual([goalId]);

    write((ctx) => {
      removeDraftGoalOf(ctx, c.shape.id, goalId);
    });
    expect(() => getGoal(c.store.db, goalId)).toThrow(NotFoundError);
    // The eval stays with the conversation, attached to no goal.
    const kept = listShapeAttachments(c.store.db, c.shape.id);
    expect(kept.map((a) => [a.kind, a.goalId, a.taskId])).toEqual([['eval', null, null]]);

    const pending = listShapeProposals(c.store.db, c.shape.id)
      .filter((r) => r.state === ShapeProposalState.Pending)
      .map((r) => r.id);
    const second = write((ctx) => convertProposals(ctx, c.shape.id, pending));
    if (!second.ok) throw new Error(second.errors.join('; '));
    const newGoalId = must(second.results.find((r) => r.key === 'g')?.goalId, 'the new goal id');
    expect(newGoalId).not.toBe(goalId);
    const again = listShapeAttachments(c.store.db, c.shape.id);
    expect(again.map((a) => [a.kind, a.goalId])).toEqual([['eval', newGoalId]]);
  });

  describe('with a diagram attached by id', () => {
    const diagram = { kind: 'mermaid', source: 'graph TD; A-->B' } as const;

    it.each(['goal', 'task'] as const)(
      'returns a diagram attached by %s id to its proposal row, and relinks it on a new Convert',
      (by) => {
        const { goalId, taskIds } = convertedGoalAndDecision();
        const id = by === 'goal' ? goalId : must(taskIds[0], 'the task id');
        write((ctx) =>
          attach(ctx, c.shape.id, {
            target: by === 'goal' ? { goalId: goalId } : { taskId: id as TaskId },
            attachment: diagram,
          }),
        );
        expect(listShapeAttachments(c.store.db, c.shape.id).map((a) => a.key)).toEqual([id]);

        write((ctx) => {
          removeDraftGoalOf(ctx, c.shape.id, goalId);
        });
        // The diagram is keyed by the row it was attached to, and attached to no goal or task.
        const wanted = by === 'goal' ? 'g' : 'g1';
        expect(
          listShapeAttachments(c.store.db, c.shape.id).map((a) => [a.key, a.goalId, a.taskId]),
        ).toEqual([[wanted, null, null]]);

        const pending = listShapeProposals(c.store.db, c.shape.id)
          .filter((r) => r.state === ShapeProposalState.Pending)
          .map((r) => r.id);
        const second = write((ctx) => convertProposals(ctx, c.shape.id, pending));
        if (!second.ok) throw new Error(second.errors.join('; '));
        const goal = must(
          second.results.find((r) => r.key === 'g'),
          'the new goal',
        );
        const [a] = listShapeAttachments(c.store.db, c.shape.id);
        expect(a).toMatchObject(
          by === 'goal'
            ? { key: 'g', goalId: goal.goalId, taskId: null }
            : { key: 'g1', goalId: null, taskId: goal.taskIds[0] },
        );
      },
    );

    it('returns a diagram on a task added to the goal later to that task row, and relinks it when proposed again', () => {
      const { goalId } = convertedGoalAndDecision();
      const m = c.say();
      const addition = (goal: GoalId) => ({
        key: 'extra',
        title: 'Extra',
        criteria: ['It works'],
        areas: ['api'],
        size: 'S',
        ceremony: 'direct',
        sourceMessageIds: [m],
        goalId: goal,
      });
      const convertPending = () => {
        const pending = listShapeProposals(c.store.db, c.shape.id)
          .filter((r) => r.state === ShapeProposalState.Pending)
          .map((r) => r.id);
        const out = write((ctx) => convertProposals(ctx, c.shape.id, pending));
        if (!out.ok) throw new Error(out.errors.join('; '));
        return out;
      };
      const proposed = write((ctx) =>
        reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ additions: [addition(goalId)] })),
      );
      if (!proposed.ok) throw new Error(proposed.errors.join('; '));
      const added = convertPending();
      const taskId = must(added.results.find((r) => r.key === 'extra')?.taskIds[0], 'the task id');
      write((ctx) => attach(ctx, c.shape.id, { target: { taskId }, attachment: diagram }));

      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, goalId);
      });
      // The diagram is on the addition's own row, which the goal's proposal row does not hold.
      expect(
        listShapeAttachments(c.store.db, c.shape.id).map((a) => [a.key, a.goalId, a.taskId]),
      ).toEqual([['extra', null, null]]);

      const newGoalId = must(
        convertPending().results.find((r) => r.key === 'g')?.goalId,
        'the new goal id',
      );
      const again = write((ctx) =>
        reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ additions: [addition(newGoalId)] })),
      );
      if (!again.ok) throw new Error(again.errors.join('; '));
      const newTaskId = must(
        convertPending().results.find((r) => r.key === 'extra')?.taskIds[0],
        'the new task id',
      );
      expect(newTaskId).not.toBe(taskId);
      expect(listShapeAttachments(c.store.db, c.shape.id)).toMatchObject([
        { key: 'extra', goalId: null, taskId: newTaskId },
      ]);
    });
  });

  describe('with a question converted under it', () => {
    function convertedWithQuestion(about: string): GoalId {
      const m = c.say();
      const draft = PlanDraft.parse({
        goals: [
          {
            key: 'density',
            title: 'Density',
            objective: 'Fit more.',
            ceremony: 'direct',
            sourceMessageIds: [m],
            tasks: [{ key: 'cards', title: 'Cards', areas: ['api'], size: 'S' }],
          },
        ],
        questions: [
          { key: 'who-pays', text: 'Who pays?', for: 'finance', about, sourceMessageIds: [m] },
          { key: 'free', text: 'Anything else?', for: 'finance', sourceMessageIds: [m] },
        ],
      });
      write((ctx) => reconcileDraft(ctx, c.shape.id, draft));
      const ids = listShapeProposals(c.store.db, c.shape.id).map((r) => r.id);
      const out = write((ctx) => convertProposals(ctx, c.shape.id, ids));
      if (!out.ok) throw new Error(out.errors.join('; '));
      return must(out.results.find((r) => r.key === 'density')?.goalId, 'the goal id');
    }

    it.each([
      ['the goal', 'density'],
      ['one of its tasks', 'cards'],
    ])('takes back a question about %s, and it converts again with the goal', (_, about) => {
      const goalId = convertedWithQuestion(about);
      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, goalId);
      });

      expect(() => getGoal(c.store.db, goalId)).toThrow(NotFoundError);
      expect(listShapeQuestions(c.store.db, c.shape.id).map((q) => q.key)).toEqual(['free']);
      expect(listShapeLinks(c.store.db, c.shape.id).map((l) => l.key)).toEqual(['free']);
      const rows = listShapeProposals(c.store.db, c.shape.id);
      expect(rows.find((r) => r.key === 'who-pays')?.state).toBe(ShapeProposalState.Pending);
      // A question that belongs to neither stays converted.
      expect(rows.find((r) => r.key === 'free')?.state).toBe(ShapeProposalState.Accepted);

      const pending = rows.filter((r) => r.state === ShapeProposalState.Pending).map((r) => r.id);
      const out = write((ctx) => convertProposals(ctx, c.shape.id, pending));
      expect(out).toMatchObject({ ok: true, createdNow: 2 });
      const [task] = listTasks(c.store.db, c.project.id);
      const question = listShapeQuestions(c.store.db, c.shape.id).find((q) => q.key === 'who-pays');
      const links = listShapeLinks(c.store.db, c.shape.id);
      if (about === 'cards') expect(question?.taskId).toBe(task?.id);
      else expect(question?.goalId).toBe(links.find((l) => l.key === 'density')?.goalId);
    });

    it('takes back a question about a task added to the goal later, and it cannot land on the cancelled task', () => {
      const goalId = convertedWithQuestion('density');
      const m = c.say();
      const addition = {
        key: 'extra',
        title: 'Extra',
        criteria: ['It works'],
        areas: ['api'],
        size: 'S',
        ceremony: 'direct',
        sourceMessageIds: [m],
        goalId,
      };
      const question = {
        key: 'on-extra',
        text: 'Which extra?',
        for: 'finance',
        about: 'extra',
        sourceMessageIds: [m],
      };
      write((ctx) =>
        reconcileDraft(
          ctx,
          c.shape.id,
          PlanDraft.parse({ additions: [addition], questions: [question] }),
        ),
      );
      const selected = listShapeProposals(c.store.db, c.shape.id)
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.id);
      const converted = write((ctx) => convertProposals(ctx, c.shape.id, selected));
      if (!converted.ok) throw new Error(converted.errors.join('; '));

      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, goalId);
      });

      const stale = listShapeQuestions(c.store.db, c.shape.id).filter((q) => q.taskId !== null);
      expect(stale).toEqual([]);
      const row = must(
        listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'on-extra'),
        'the question',
      );
      expect(row.state).toBe(ShapeProposalState.Pending);
      expect(write((ctx) => convertProposals(ctx, c.shape.id, [row.id]))).toEqual({
        ok: false,
        errors: [
          'on-extra is about extra, which was converted and then taken back (propose it again under the same key once its goal is converted), so it cannot hold a question',
        ],
      });

      // Propose judges it the same way, a new question or the old one restated.
      for (const key of ['late', 'on-extra']) {
        const refused = write((ctx) =>
          reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ questions: [{ ...question, key }] })),
        );
        expect(refused.ok ? [] : refused.errors).toEqual([
          expect.stringMatching(/Question 1, about: extra is not a goal or task/),
        ]);
      }
    });

    it('lets a task added to the removed goal be proposed again under its key, and the question converts with it', () => {
      const goalId = convertedWithQuestion('density');
      const m = c.say();
      const addition = (goal: GoalId) => ({
        key: 'extra',
        title: 'Extra',
        criteria: ['It works'],
        areas: ['api'],
        size: 'S',
        ceremony: 'direct',
        sourceMessageIds: [m],
        goalId: goal,
      });
      const question = {
        key: 'on-extra',
        text: 'Which extra?',
        for: 'finance',
        about: 'extra',
        sourceMessageIds: [m],
      };
      const first = write((ctx) =>
        reconcileDraft(
          ctx,
          c.shape.id,
          PlanDraft.parse({ additions: [addition(goalId)], questions: [question] }),
        ),
      );
      if (!first.ok) throw new Error(first.errors.join('; '));
      const selected = listShapeProposals(c.store.db, c.shape.id)
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.id);
      const converted = write((ctx) => convertProposals(ctx, c.shape.id, selected));
      if (!converted.ok) throw new Error(converted.errors.join('; '));
      write((ctx) => {
        removeDraftGoalOf(ctx, c.shape.id, goalId);
      });

      // While the goal is not converted again, the session is told why the addition cannot be proposed.
      const early = write((ctx) =>
        reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ additions: [addition(goalId)] })),
      );
      expect(early.ok ? [] : early.errors).toEqual([
        expect.stringMatching(/is not a goal this conversation converted/),
      ]);

      const goalRow = must(
        listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === 'density'),
        'the goal',
      );
      const again = write((ctx) => convertProposals(ctx, c.shape.id, [goalRow.id]));
      if (!again.ok) throw new Error(again.errors.join('; '));
      const newGoalId = must(again.results.find((r) => r.key === 'density')?.goalId, 'the goal');

      const restated = write((ctx) =>
        reconcileDraft(
          ctx,
          c.shape.id,
          // A round supersedes the pending rows it leaves out, so the question is restated too.
          PlanDraft.parse({ additions: [addition(newGoalId)], questions: [question] }),
        ),
      );
      if (!restated.ok) throw new Error(restated.errors.join('; '));
      const rows = listShapeProposals(c.store.db, c.shape.id);
      const pending = rows.filter((r) => r.state === ShapeProposalState.Pending);
      expect(pending.map((r) => r.key).sort()).toEqual(['extra', 'on-extra']);

      const out = write((ctx) =>
        convertProposals(
          ctx,
          c.shape.id,
          pending.map((r) => r.id),
        ),
      );
      expect(out).toMatchObject({ ok: true, createdNow: 2 });
      const extra = listTasks(c.store.db, c.project.id).find((t) => t.title === 'Extra');
      expect(extra?.goalId).toBe(newGoalId);
      expect(
        listShapeQuestions(c.store.db, c.shape.id).find((q) => q.key === 'on-extra'),
      ).toMatchObject({ taskId: extra?.id });
    });

    it('leaves the question where it was when the removal is refused', () => {
      const goalId = convertedWithQuestion('density');
      const [task] = listTasks(c.store.db, c.project.id);
      write((ctx) => insertWorkstream(ctx, task?.id ?? mintId('Task')));
      expect(() => {
        write((ctx) => {
          removeDraftGoalOf(ctx, c.shape.id, goalId);
        });
      }).toThrow(/has started/);
      expect(listShapeQuestions(c.store.db, c.shape.id).map((q) => q.goalId)).toContain(goalId);
      expect(listShapeProposals(c.store.db, c.shape.id).map((r) => r.state)).not.toContain(
        ShapeProposalState.Pending,
      );
    });
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
