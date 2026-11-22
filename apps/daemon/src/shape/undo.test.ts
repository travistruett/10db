import {
  ConflictError,
  InvalidError,
  NotFoundError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type ConversationItemId,
  KnowledgeState,
  PlanDraft,
  ShapeOrigin,
  ShapeProposalState,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type ShapeAcceptId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import {
  createTestStore,
  getDecision,
  getGoal,
  getPrinciple,
  getShapeAccept,
  getTask,
  insertPerson,
  insertPlanSession,
  insertShapeMessage,
  insertSource,
  insertTask,
  insertWorkstream,
  insertGoalTask,
  latestShapeAccept,
  listShapeLinks,
  listShapeProposals,
  listShapeQuestions,
  schema,
  searchPrincipleIds,
  seedProject,
  supersedeDecision,
  transitionWorkstream,
  withdrawDecision,
  type Store,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { convertProposals } from './convert';
import { reconcileDraft } from './rounds';
import { undoAccept } from './undo';

let handle: ReturnType<typeof createTestStore> | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
});

function world(): { store: Store; projectId: ProjectId } {
  handle = createTestStore();
  const projectId = seedProject(handle.store).id;
  handle.store.write((ctx) => insertPerson(ctx, { handle: 'me', name: 'Me', isBuilder: true }));
  return { store: handle.store, projectId };
}

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  ...extra,
});

function newPlan(store: Store, projectId: ProjectId): ShapeId {
  return store.write((ctx) =>
    insertPlanSession(ctx, {
      projectId,
      title: 'Plan',
      origin: ShapeOrigin.App,
      tabPosition: null,
    }),
  ).value.shape.id;
}

/** Every row of a draft cites the builder's message and has a criterion, as a round requires. */
function cited(
  draft: Record<string, unknown>,
  source: ConversationItemId,
): Record<string, unknown> {
  const row = (r: unknown): Record<string, unknown> => ({
    ...(r as Record<string, unknown>),
    sourceMessageIds: [source],
    criteria: ['Done'],
  });
  return Object.fromEntries(
    Object.entries(draft).map(([name, rows]) => [
      name,
      (rows as Record<string, unknown>[]).map((r) =>
        name === 'goals'
          ? { ...row(r), criteria: [], tasks: (r['tasks'] as unknown[]).map(row) }
          : row(r),
      ),
    ]),
  );
}

/** States a round, then accepts every pending proposal: one Accept. */
function accept(store: Store, shapeId: ShapeId, draft: Record<string, unknown>): ShapeAcceptId {
  return store.write((ctx) => {
    const source = insertShapeMessage(ctx, shapeId, {
      author: ShapeMessageAuthor.Builder,
      kind: ShapeMessageKind.Text,
      body: 'Do this',
    }).id;
    const round = reconcileDraft(ctx, shapeId, PlanDraft.parse(cited(draft, source)));
    if (!round.ok) throw new Error(round.errors.join('; '));
    const outcome = convertProposals(
      ctx,
      shapeId,
      listShapeProposals(ctx.tx, shapeId)
        .filter((p) => p.state === ShapeProposalState.Pending)
        .map((p) => p.id),
    );
    if (!outcome.ok) throw new Error(outcome.errors.join('; '));
    if (outcome.acceptId === null) throw new Error('nothing was accepted');
    return outcome.acceptId;
  }).value;
}

const taskOf = (store: Store, shapeId: ShapeId, key: string): TaskId => {
  const id = listShapeLinks(store.db, shapeId).find((l) => l.key === key)?.taskId;
  if (id === undefined || id === null) throw new Error(`no task ${key}`);
  return id;
};

const proposal = (store: Store, shapeId: ShapeId, key: string) => {
  const row = listShapeProposals(store.db, shapeId).find((p) => p.key === key);
  if (row === undefined) throw new Error(`no proposal ${key}`);
  return row;
};

const decisionRecord = (key: string) => ({
  kind: 'decision',
  key,
  scope: 'project',
  question: `Question ${key}?`,
  choice: `Choice ${key}`,
  rationale: 'Because',
});

/** Every proposal's state, every task's status and each Accept's undone mark: what a refusal must keep. */
function snapshot(store: Store, shapeId: ShapeId, taskIds: TaskId[]): unknown {
  return {
    proposals: listShapeProposals(store.db, shapeId).map((p) => [p.key, p.state, p.acceptId]),
    tasks: taskIds.map((id) => getTask(store.db, id).status),
    links: listShapeLinks(store.db, shapeId).length,
    latest: latestShapeAccept(store.db, shapeId)?.id,
  };
}

describe('Undo Accept', () => {
  it('takes back only what this Accept wrote', () => {
    const { store, projectId } = world();
    const shapeId = newPlan(store, projectId);
    // An Accept before the two undone below makes task X.
    accept(store, shapeId, { looseTasks: [task('x')] });
    const x = taskOf(store, shapeId, 'x');
    const first = accept(store, shapeId, {
      goals: [
        {
          key: 'g1',
          title: 'Goal A',
          objective: 'Ship A',
          ceremony: 'direct',
          tasks: [
            { key: 'a1', title: 'A one', areas: ['api'], size: 'S' },
            { key: 'a2', title: 'A two', areas: ['api'], size: 'S', depends_on: ['a1'] },
            { key: 'a3', title: 'A three', areas: ['api'], size: 'S' },
          ],
        },
      ],
      // lb waits on a3, and a1 comes to wait on lb below: the goal and the loose task wait on each other task by task.
      looseTasks: [task('lb', { dependsOn: ['a3'] })],
      records: [
        decisionRecord('d1'),
        {
          kind: 'principle',
          key: 'p1',
          scope: 'project',
          statement: 'Prefer small pull requests',
          rationale: 'Review stays fast',
        },
      ],
    });
    const second = accept(store, shapeId, {
      looseTasks: [task('b')],
      questions: [{ key: 'q1', text: 'Who owns B?', for: 'builder', about: 'b' }],
      records: [decisionRecord('d2')],
      changes: [{ taskId: x, title: 'Task x, renamed' }],
    });
    const d2 = listShapeLinks(store.db, shapeId).find((l) => l.key === 'd2')?.decisionId;
    if (d2 === undefined || d2 === null) throw new Error('no d2');
    store.write((ctx) => {
      withdrawDecision(ctx, d2, { by: 'builder', reason: 'Changed my mind' });
    });

    const b = taskOf(store, shapeId, 'b');
    const a1 = taskOf(store, shapeId, 'a1');
    const lb = taskOf(store, shapeId, 'lb');
    store.write((ctx) => {
      ctx.tx.insert(schema.taskDeps).values({ taskId: a1, dependsOnId: lb }).run();
    });
    const undone = store.write((ctx) => undoAccept(ctx, shapeId, second)).value;
    expect(undone).toEqual({
      goals: 0,
      tasks: 1,
      decisions: 0,
      principles: 0,
      questions: 1,
      kept: 1,
    });
    expect(getTask(store.db, b).status).toBe(TaskStatus.Cancelled);
    expect(proposal(store, shapeId, 'b')).toMatchObject({
      state: ShapeProposalState.Pending,
      acceptId: null,
    });
    expect(proposal(store, shapeId, 'd2')).toMatchObject({
      state: ShapeProposalState.Pending,
      acceptId: null,
    });
    expect(listShapeQuestions(store.db, shapeId)).toEqual([]);
    expect(getTask(store.db, x).title).toBe('Task x, renamed');
    expect(proposal(store, shapeId, `change:${x}`)).toMatchObject({
      state: ShapeProposalState.Accepted,
      acceptId: second,
    });
    expect(getShapeAccept(store.db, shapeId, second)?.undoneAt).not.toBeNull();
    expect(getShapeAccept(store.db, shapeId, first)?.undoneAt).toBeNull();
    expect(proposal(store, shapeId, 'g1').state).toBe(ShapeProposalState.Accepted);
    expect(getTask(store.db, a1).status).toBe(TaskStatus.Open);
    expect(
      searchPrincipleIds(store.db, { projectId, query: 'small pull requests', limit: 5 }),
    ).toHaveLength(1);

    // A decision superseded since is left as it is, never a refusal.
    const d1 = listShapeLinks(store.db, shapeId).find((l) => l.key === 'd1')?.decisionId;
    if (d1 === undefined || d1 === null) throw new Error('no d1');
    store.write((ctx) =>
      supersedeDecision(ctx, d1, {
        projectId,
        question: 'Question d1?',
        choice: 'Another choice',
        rationale: 'Later',
        decidedBy: 'builder',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      }),
    );
    const goalA = listShapeLinks(store.db, shapeId).find((l) => l.key === 'g1')?.goalId;
    if (goalA === undefined || goalA === null) throw new Error('no goal');
    const again = store.write((ctx) => undoAccept(ctx, shapeId, first)).value;
    expect(again).toEqual({
      goals: 1,
      tasks: 4,
      decisions: 0,
      principles: 1,
      questions: 0,
      kept: 1,
    });
    expect(() => getGoal(store.db, goalA)).toThrow(NotFoundError);
    expect(getTask(store.db, a1).status).toBe(TaskStatus.Cancelled);
    expect(getTask(store.db, lb).status).toBe(TaskStatus.Cancelled);
    expect(getDecision(store.db, d1).withdrawnAt).toBeNull();
    expect(proposal(store, shapeId, 'd1').state).toBe(ShapeProposalState.Accepted);
    expect(
      searchPrincipleIds(store.db, { projectId, query: 'small pull requests', limit: 5 }),
    ).toEqual([]);
    expect(
      searchPrincipleIds(store.db, {
        projectId,
        query: 'small pull requests',
        limit: 5,
        history: true,
      }).map((id) => getPrinciple(store.db, id).state),
    ).toEqual([KnowledgeState.Withdrawn]);
  });

  it('refuses and writes nothing when a task it would remove has any run, a goal holds a task it did not make, or an outside task waits on one', () => {
    const { store, projectId } = world();
    const refused = (
      shapeId: ShapeId,
      acceptId: ShapeAcceptId,
      taskIds: TaskId[],
      error: new (message: string) => Error,
      message: RegExp,
    ): void => {
      const before = snapshot(store, shapeId, taskIds);
      expect(() => store.write((ctx) => undoAccept(ctx, shapeId, acceptId))).toThrow(error);
      expect(() => store.write((ctx) => undoAccept(ctx, shapeId, acceptId))).toThrow(message);
      expect(snapshot(store, shapeId, taskIds)).toEqual(before);
      expect(getShapeAccept(store.db, shapeId, acceptId)?.undoneAt).toBeNull();
    };

    // A run cancelled before any session still counts as a run.
    const a = newPlan(store, projectId);
    const acceptA = accept(store, a, { looseTasks: [task('l1')] });
    const l1 = taskOf(store, a, 'l1');
    store.write((ctx) => {
      const run = insertWorkstream(ctx, l1, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      transitionWorkstream(ctx, run.id, { to: WorkstreamState.Cancelled, fence: null });
    });
    refused(a, acceptA, [l1], ConflictError, /has started; cancel its run/);

    // A task added to its goal outside the Accept.
    const b = newPlan(store, projectId);
    const acceptB = accept(store, b, {
      goals: [
        {
          key: 'g',
          title: 'Goal B',
          objective: 'Ship B',
          ceremony: 'direct',
          tasks: [{ key: 'b1', title: 'B one', areas: ['api'], size: 'S' }],
        },
      ],
    });
    const goalB = listShapeLinks(store.db, b).find((l) => l.key === 'g')?.goalId;
    if (goalB === undefined || goalB === null) throw new Error('no goal');
    const added = store.write((ctx) =>
      insertGoalTask(ctx, projectId, goalB, {
        title: 'Added on the Board',
        description: '',
        acceptanceCriteria: ['done'],
        areas: ['api'],
        dependsOn: [],
      }),
    ).value;
    refused(b, acceptB, [taskOf(store, b, 'b1'), added.id], ConflictError, /didn't make/);

    // An open task outside the Accept waits on one of its tasks.
    const c = newPlan(store, projectId);
    const acceptC = accept(store, c, { looseTasks: [task('c1')] });
    const c1 = taskOf(store, c, 'c1');
    const waiting = store.write((ctx) =>
      insertTask(ctx, projectId, {
        title: 'Waits on c1',
        description: '',
        acceptanceCriteria: ['done'],
        areas: ['api'],
        dependsOn: [c1],
      }),
    ).value;
    refused(c, acceptC, [c1, waiting.id], Error, /Waits on c1/);

    // Only the latest Accept is undone.
    const d = newPlan(store, projectId);
    const early = accept(store, d, { looseTasks: [task('e1')] });
    accept(store, d, { looseTasks: [task('e2')] });
    refused(
      d,
      early,
      [taskOf(store, d, 'e1'), taskOf(store, d, 'e2')],
      InvalidError,
      /later Accept/,
    );
  });
});

describe('Convert and a linked issue', () => {
  const link = (id: string) => ({
    kind: 'linear' as const,
    id,
    issueId: `lin-${id}`,
    url: `https://linear.app/acme/issue/${id}`,
  });

  it('skips a draft whose issue is on the Board, leaves its card to Undo, and refuses a second create', () => {
    const { store, projectId } = world();
    const shapeId = newPlan(store, projectId);
    accept(store, shapeId, { looseTasks: [task('a', { external: link('AMP-1') })] });
    const existing = taskOf(store, shapeId, 'a');
    expect(getTask(store.db, existing).external?.id).toBe('AMP-1');

    const second = accept(store, shapeId, {
      looseTasks: [
        task('again', { external: link('AMP-1') }),
        task('fresh', { external: link('AMP-2') }),
      ],
    });
    const tasks = store.db.select().from(schema.tasks).all();
    expect(tasks.map((t) => t.externalId).sort()).toEqual(['AMP-1', 'AMP-2']);
    expect(proposal(store, shapeId, 'again').state).toBe(ShapeProposalState.Accepted);
    expect(listShapeLinks(store.db, shapeId).some((l) => l.key === 'again')).toBe(false);

    // Undo takes back the Accept's own card only; the skipped draft's card stays.
    store.write((ctx) => undoAccept(ctx, shapeId, second));
    expect(getTask(store.db, existing).status).not.toBe(TaskStatus.Cancelled);

    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, projectId, {
          title: 'By hand',
          acceptanceCriteria: ['Done'],
          areas: ['api'],
          external: link('AMP-1'),
        }),
      ),
    ).toThrow(/AMP-1 is already the task/);
  });
});
