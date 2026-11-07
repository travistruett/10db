import {
  CriterionCheck,
  Effort,
  GoalState,
  GoalStatus,
  NotFoundError,
  TaskHasDependentsError,
  TaskStartedError,
  TaskStatus,
  WorkstreamState,
  mintId,
  type GoalId,
  type ProjectDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  BUILDER_HANDLE,
  cancelTask,
  closeTask,
  createTestStore,
  getGoal,
  getTask,
  getWorkstream,
  goalDigest,
  holdTask,
  insertGoal,
  insertPerson,
  insertSession,
  insertTask,
  insertWorkstream,
  listGoalTasks,
  listTasks,
  removeDraftGoal,
  seedProject,
  transitionWorkstream,
  type Store,
  type WriteContext,
} from './index';

// Shape spec §11, Remove Draft Goal: while every task is unstarted, the goal goes with its tasks and
// criteria in one transaction.

let store: Store;
let close: () => void;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
  store.write((ctx) => insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }));
});
afterEach(() => {
  close();
});

function seedGoal(): GoalId {
  return store.write((ctx) =>
    insertGoal(ctx, project.id, {
      brief: {
        title: 'Real areas',
        objective: 'Propose areas.',
        criteria: [{ text: 'It works', check: CriterionCheck.Command }],
        people: [],
        tasks: [
          { key: 'a', title: 'First', areas: ['api'], criteria: ['x'], depends_on: [] },
          { key: 'b', title: 'Second', areas: ['api'], criteria: ['x'], depends_on: ['a'] },
        ],
      },
    }),
  ).value.goal.id;
}

const remove = (id: GoalId) =>
  store.write((ctx) => {
    removeDraftGoal(ctx, id);
  });

describe('removeDraftGoal', () => {
  it('removes the tasks, the criteria and the goal, whatever order the tasks wait on each other', () => {
    const id = seedGoal();
    remove(id);
    expect(() => getGoal(store.db, id)).toThrow(NotFoundError);
    expect(listTasks(store.db, project.id)).toEqual([]);
    expect(
      store.db.select().from(schema.goalCriteria).where(eq(schema.goalCriteria.goalId, id)).all(),
    ).toEqual([]);
    const gone = store.db.select().from(schema.tasks).all();
    expect(gone.map((t) => [t.status, t.goalId])).toEqual([
      [TaskStatus.Cancelled, null],
      [TaskStatus.Cancelled, null],
    ]);
  });

  it('refuses once a task has started, and removes nothing', () => {
    const id = seedGoal();
    const [first] = listGoalTasks(store.db, id);
    store.write((ctx) =>
      insertWorkstream(ctx, first?.id ?? mintId('Task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    expect(() => remove(id)).toThrow(TaskStartedError);
    expect(getGoal(store.db, id).state).toBe(GoalState.Draft);
    expect(listTasks(store.db, project.id)).toHaveLength(2);
  });

  // The digest reads a goal as not started while a run was only queued, held or cancelled before
  // any session, and the Remove Draft Goal action is offered then; the removal must agree.
  it('removes a goal whose task had a run cancelled while queued, as the digest reads it as not started', () => {
    const id = seedGoal();
    const [first] = listGoalTasks(store.db, id);
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, first?.id ?? mintId('Task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
    store.write((ctx) =>
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Cancelled, fence: null }),
    );
    expect(goalDigest(store.db, id, null).status).toBe(GoalStatus.NotStarted);
    remove(id);
    expect(() => getGoal(store.db, id)).toThrow(NotFoundError);
    expect(listTasks(store.db, project.id)).toEqual([]);
  });

  it('refuses a goal whose task had a run cancelled after a session, as the digest reads it as started', () => {
    const id = seedGoal();
    const [first] = listGoalTasks(store.db, id);
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, first?.id ?? mintId('Task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
    store.write((ctx) => {
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet-5.5',
        effort: Effort.High,
        mode: 'managed',
        mcpTokenHash: `hash-${ws.id}`,
      });
      transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Cancelled, fence: null });
    });
    expect(goalDigest(store.db, id, null).status).toBe(GoalStatus.Idle);
    expect(() => remove(id)).toThrow(TaskStartedError);
    expect(getGoal(store.db, id).state).toBe(GoalState.Draft);
  });

  // A task can start again after a run that ended, so its latest run alone doesn't say whether it
  // ever ran. Each earlier run here did work; the digest and the removal must both say so.
  describe.each([
    {
      earlier: 'failed',
      firstRun: (ctx: WriteContext, ws: WorkstreamDto) => {
        for (const to of [
          WorkstreamState.Starting,
          WorkstreamState.Running,
          WorkstreamState.Failed,
        ])
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      },
    },
    {
      earlier: 'was cancelled after a session',
      firstRun: (ctx: WriteContext, ws: WorkstreamDto) => {
        insertSession(ctx, {
          workstreamId: ws.id,
          provider: 'claude',
          model: 'sonnet-5.5',
          effort: Effort.High,
          mode: 'managed',
          mcpTokenHash: `hash-${ws.id}`,
        });
        transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Cancelled, fence: null });
      },
    },
  ])('a task whose earlier run $earlier', ({ firstRun }) => {
    function startAgain(): { id: GoalId; taskId: TaskId; again: WorkstreamDto } {
      const id = seedGoal();
      const taskId = listGoalTasks(store.db, id)[0]?.id ?? mintId('Task');
      const first = store.write((ctx) =>
        insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
      ).value;
      store.write((ctx) => {
        firstRun(ctx, first);
      });
      return {
        id,
        taskId,
        again: store.write((ctx) =>
          insertWorkstream(ctx, taskId, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          }),
        ).value,
      };
    }

    function expectRefused(id: GoalId): void {
      expect(goalDigest(store.db, id, null).status).toBe(GoalStatus.Idle);
      expect(() => remove(id)).toThrow(TaskStartedError);
      expect(getGoal(store.db, id).state).toBe(GoalState.Draft);
      expect(listGoalTasks(store.db, id).map((t) => t.status)).toEqual([
        TaskStatus.Open,
        TaskStatus.Open,
      ]);
    }

    it('refuses when the task was started again and that run cancelled while queued', () => {
      const { id, again } = startAgain();
      store.write((ctx) =>
        transitionWorkstream(ctx, again.id, { to: WorkstreamState.Cancelled, fence: null }),
      );
      expectRefused(id);
    });

    it('refuses when the task was started again and that run is held', () => {
      const { id, taskId, again } = startAgain();
      store.write((ctx) => holdTask(ctx, taskId));
      expectRefused(id);
      expect(getWorkstream(store.db, again.id).state).toBe(WorkstreamState.Held);
    });
  });

  it('removes a goal whose task was started again after a run that never began, with that run held', () => {
    const id = seedGoal();
    const taskId = listGoalTasks(store.db, id)[0]?.id ?? mintId('Task');
    const first = store.write((ctx) =>
      insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    store.write((ctx) =>
      transitionWorkstream(ctx, first.id, { to: WorkstreamState.Cancelled, fence: null }),
    );
    const again = store.write((ctx) =>
      insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    store.write((ctx) => holdTask(ctx, taskId));
    expect(goalDigest(store.db, id, null).status).toBe(GoalStatus.NotStarted);
    remove(id);
    expect(() => getGoal(store.db, id)).toThrow(NotFoundError);
    expect(getWorkstream(store.db, again.id).state).toBe(WorkstreamState.Cancelled);
  });

  it('removes a goal when the only task that ran was already removed, as the digest reads it as not started', () => {
    const id = seedGoal();
    const [first] = listGoalTasks(store.db, id);
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, first?.id ?? mintId('Task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    ).value;
    store.write((ctx) => {
      for (const to of [WorkstreamState.Starting, WorkstreamState.Running, WorkstreamState.Failed])
        transitionWorkstream(ctx, ws.id, { to, fence: null });
    });
    const [, second] = listGoalTasks(store.db, id);
    store.write((ctx) => cancelTask(ctx, second?.id ?? mintId('Task')));
    store.write((ctx) => closeTask(ctx, first?.id ?? mintId('Task')));
    expect(goalDigest(store.db, id, null).status).toBe(GoalStatus.NotStarted);
    remove(id);
    expect(() => getGoal(store.db, id)).toThrow(NotFoundError);
  });

  it('refuses while a task outside the goal waits on one of its tasks', () => {
    const id = seedGoal();
    const [first] = listGoalTasks(store.db, id);
    store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Waits',
        acceptanceCriteria: ['x'],
        areas: ['api'],
        dependsOn: [first?.id ?? mintId('Task')],
      }),
    );
    expect(() => remove(id)).toThrow(TaskHasDependentsError);
    expect(listGoalTasks(store.db, id).every((t) => t.status === TaskStatus.Open)).toBe(true);
  });

  it('refuses a goal that is no longer a draft', () => {
    const id = seedGoal();
    store.db
      .update(schema.goals)
      .set({ state: GoalState.Running })
      .where(eq(schema.goals.id, id))
      .run();
    expect(() => remove(id)).toThrow(/draft/);
    expect(getTask(store.db, listGoalTasks(store.db, id)[0]?.id ?? mintId('Task')).status).toBe(
      TaskStatus.Open,
    );
  });
});
