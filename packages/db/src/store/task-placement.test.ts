import {
  ConflictError,
  InvalidError,
  type ProjectId,
  type ProjectInput,
  type TaskId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  createTestStore,
  currentBatch,
  getProject,
  getTask,
  insertBatch,
  insertBoardColumn,
  insertTask,
  insertWorkstream,
  listProjectViews,
  moveTask,
  patchProject,
  patchTask,
  seedProject,
  setTaskStatus,
  transitionBatch,
  type Placement,
  type Store,
} from './index';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const prConfig = { delivery: 'pull_request', prTitlePrefix: 'feat(app)' } as const;
const project = (overrides: Partial<ProjectInput> = {}) =>
  seedProject(store, { ...prConfig, ...overrides });
const addTask = (projectId: ProjectId, extra: { workspaceMode?: 'shared' | 'worktree' } = {}) =>
  store.write((ctx) =>
    insertTask(ctx, projectId, {
      title: 'Alpha',
      acceptanceCriteria: ['x'],
      areas: ['api'],
      ...extra,
    }),
  ).value;
const place = (id: TaskId, workspaceMode: 'shared' | 'worktree') =>
  store.write((ctx) => patchTask(ctx, id, { workspaceMode })).value;
const refusal = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};
/** Sets the latest run's state directly: the transitions under test are the patch's, not the workstream's. */
const runIn = (taskId: TaskId, state: string) => {
  const ws = store.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value;
  store.db.$client.prepare('UPDATE workstreams SET state = ? WHERE id = ?').run(state, ws.id);
};

describe('task placement', () => {
  it('a new task takes the project default, or the placement it names', () => {
    const shared = project();
    expect(addTask(shared.id)).toMatchObject({ workspaceMode: 'shared', placementReason: null });
    expect(addTask(shared.id, { workspaceMode: 'worktree' }).workspaceMode).toBe('worktree');
    const copies = project({ workspaceMode: 'worktree' });
    expect(addTask(copies.id).workspaceMode).toBe('worktree');
  });

  it('a local project refuses a separate copy for a new task', () => {
    const local = seedProject(store);
    expect(addTask(local.id).workspaceMode).toBe('shared');
    expect(() => addTask(local.id, { workspaceMode: 'worktree' })).toThrow(InvalidError);
  });

  it('a placement patch is accepted for a task with no run, a failed or cancelled run, and a parked task', () => {
    const p = project();
    const fresh = addTask(p.id);
    expect(place(fresh.id, 'worktree')).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'chosen by the builder',
    });
    for (const state of ['FAILED', 'CANCELLED']) {
      const task = addTask(p.id);
      runIn(task.id, state);
      expect(place(task.id, 'worktree').workspaceMode).toBe('worktree');
    }
    const parked = addTask(p.id);
    const column = store.write((ctx) => insertBoardColumn(ctx, p.id, { name: 'Later' })).value;
    store.write((ctx) => moveTask(ctx, parked.id, { to: column.id, after: null, before: null }));
    expect(place(parked.id, 'worktree').workspaceMode).toBe('worktree');
  });

  it('a new task stores the placement and reason it is given, over the one it names', () => {
    const p = project();
    const made = store.write((ctx) =>
      insertTask(
        ctx,
        p.id,
        { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'], workspaceMode: 'shared' },
        { workspaceMode: 'worktree', reason: 'touches migrations' },
      ),
    ).value;
    expect(made).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'touches migrations',
    });
    expect(getTask(store.db, made.id).placementReason).toBe('touches migrations');
  });

  it('a placement the builder sets replaces a proposed reason with one saying the builder chose it', () => {
    const p = project();
    const task = addTask(p.id);
    store.db
      .update(schema.tasks)
      .set({ placementReason: 'touches migrations' })
      .where(eq(schema.tasks.id, task.id))
      .run();
    expect(getTask(store.db, task.id).placementReason).toBe('touches migrations');
    expect(place(task.id, 'shared')).toMatchObject({
      workspaceMode: 'shared',
      placementReason: 'chosen by the builder',
    });
    expect(getTask(store.db, task.id).placementReason).toBe('chosen by the builder');
  });

  it.each(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'PAUSED_LIMIT'])(
    'a placement patch is refused while the latest run is %s',
    (state) => {
      const p = project();
      const task = addTask(p.id);
      runIn(task.id, state);
      const error = refusal(() => place(task.id, 'worktree'));
      expect(error).toBeInstanceOf(ConflictError);
      expect(String(error)).toContain('Alpha has started');
      expect(getTask(store.db, task.id).workspaceMode).toBe('shared');
    },
  );

  it('a placement patch is refused for a QUEUED run in a CUTTING shared batch', () => {
    const p = project();
    const task = addTask(p.id);
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId: p.id, title: 'Cutting', baseBranch: 'main' }),
    ).value;
    store.write((ctx) =>
      insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        batchId: batch.id,
      }),
    );
    expect(() => place(task.id, 'worktree')).toThrow(ConflictError);
  });

  it('a placement patch is refused for a task that is not open', () => {
    const p = project();
    const task = addTask(p.id);
    store.write((ctx) => {
      setTaskStatus(ctx, task.id, 'done');
    });
    const error = refusal(() => place(task.id, 'worktree'));
    expect(error).toBeInstanceOf(ConflictError);
    expect(String(error)).toContain('Alpha is finished');
  });

  describe('a placement proposed again with a patch', () => {
    const proposed: Placement = { workspaceMode: 'worktree', reason: 'touches migrations' };
    const edit = (id: TaskId, placement: Placement = proposed) =>
      store.write((ctx) => patchTask(ctx, id, { headline: 'Edited' }, placement)).value;

    it('moves an unstarted shared task to a separate copy with the reason', () => {
      const task = addTask(project().id);
      expect(edit(task.id)).toMatchObject({
        workspaceMode: 'worktree',
        placementReason: 'touches migrations',
      });
      expect(getTask(store.db, task.id)).toMatchObject({
        workspaceMode: 'worktree',
        placementReason: 'touches migrations',
      });
    });

    it('moves a task whose latest run failed', () => {
      const task = addTask(project().id);
      runIn(task.id, 'FAILED');
      expect(edit(task.id).workspaceMode).toBe('worktree');
    });

    it('leaves a task the builder placed alone, and keeps the builder as the reason', () => {
      const task = addTask(project().id);
      place(task.id, 'shared');
      expect(edit(task.id)).toMatchObject({
        workspaceMode: 'shared',
        placementReason: 'chosen by the builder',
      });
    });

    it('leaves a task that has started where it is', () => {
      const task = addTask(project().id);
      runIn(task.id, 'RUNNING');
      expect(edit(task.id)).toMatchObject({ workspaceMode: 'shared', placementReason: null });
    });

    it('leaves a task that is not open where it is', () => {
      const task = addTask(project().id);
      store.write((ctx) => {
        setTaskStatus(ctx, task.id, 'done');
      });
      expect(edit(task.id).workspaceMode).toBe('shared');
    });

    it('does nothing in a project with local delivery', () => {
      const task = addTask(seedProject(store).id);
      expect(edit(task.id)).toMatchObject({ workspaceMode: 'shared', placementReason: null });
    });

    it('gives a copy the caller named, with no reason, the proposed reason', () => {
      const task = addTask(project().id, { workspaceMode: 'worktree' });
      expect(edit(task.id)).toMatchObject({
        workspaceMode: 'worktree',
        placementReason: 'touches migrations',
      });
    });

    describe('when the reason was already proposed by the rule', () => {
      const moved = () => {
        const task = addTask(project().id);
        edit(task.id);
        return task;
      };

      it('replaces it with the reason for the new kinds', () => {
        const task = moved();
        const deps: Placement = { workspaceMode: 'worktree', reason: 'touches dependencies' };
        const patched = store.write((ctx) =>
          patchTask(ctx, task.id, { headline: 'Edited again' }, deps),
        ).value;
        expect(patched).toMatchObject({
          workspaceMode: 'worktree',
          placementReason: 'touches dependencies',
        });
      });

      it('returns the task to the default placement with no reason once the rule no longer matches', () => {
        const task = moved();
        const none: Placement = { workspaceMode: 'shared', reason: null };
        const patched = store.write((ctx) =>
          patchTask(ctx, task.id, { headline: 'Edited once more' }, none),
        ).value;
        expect(patched).toMatchObject({ workspaceMode: 'shared', placementReason: null });
        expect(getTask(store.db, task.id)).toMatchObject({
          workspaceMode: 'shared',
          placementReason: null,
        });
      });

      it('keeps the reason once the task has started', () => {
        const task = moved();
        runIn(task.id, 'RUNNING');
        const none: Placement = { workspaceMode: 'shared', reason: null };
        const patched = store.write((ctx) =>
          patchTask(ctx, task.id, { headline: 'Edited once more' }, none),
        ).value;
        expect(patched).toMatchObject({
          workspaceMode: 'worktree',
          placementReason: 'touches migrations',
        });
      });

      it('keeps what the builder chose when the rule stops matching', () => {
        const task = moved();
        place(task.id, 'worktree');
        const none: Placement = { workspaceMode: 'shared', reason: null };
        const patched = store.write((ctx) =>
          patchTask(ctx, task.id, { headline: 'Edited once more' }, none),
        ).value;
        expect(patched).toMatchObject({
          workspaceMode: 'worktree',
          placementReason: 'chosen by the builder',
        });
      });
    });

    it('a proposal that says shared changes nothing', () => {
      const task = addTask(project().id);
      const shared = { workspaceMode: 'shared', reason: null } as const;
      expect(edit(task.id, shared)).toMatchObject({
        workspaceMode: 'shared',
        placementReason: null,
      });
    });

    it('a copy proposed with no reason leaves a shared task with no reason where it is', () => {
      // The project's default is a separate copy, so the rule answers worktree without matching.
      const task = addTask(project().id, { workspaceMode: 'shared' });
      const unmatched = { workspaceMode: 'worktree', reason: null } as const;
      expect(edit(task.id, unmatched)).toMatchObject({
        workspaceMode: 'shared',
        placementReason: null,
      });
    });
  });

  it('a placement patch is refused in a project with local delivery', () => {
    const local = seedProject(store);
    const task = addTask(local.id);
    for (const mode of ['worktree', 'shared'] as const) {
      const error = refusal(() => place(task.id, mode));
      expect(error).toBeInstanceOf(InvalidError);
      expect(String(error)).toContain('pull request');
    }
  });
});

describe('project placement defaults', () => {
  it('a project isolates migrations and deps unless it says otherwise', () => {
    expect(project().isolate).toEqual(['migrations', 'deps']);
    const custom = project({ isolate: ['migrations', 'deps', 'contracts'] });
    expect(getProject(store.db, custom.id).isolate).toEqual(['migrations', 'deps', 'contracts']);
    const patched = store.write((ctx) => patchProject(ctx, custom.id, { isolate: ['deps'] })).value;
    expect(patched.isolate).toEqual(['deps']);
  });

  it("a project's default mode changes with work in flight, and leaves its tasks where they are", () => {
    const p = project();
    const task = addTask(p.id);
    store.write((ctx) =>
      insertBatch(ctx, { projectId: p.id, title: 'Open one', baseBranch: 'main' }),
    );
    runIn(addTask(p.id).id, 'RUNNING');
    const patched = store.write((ctx) => patchProject(ctx, p.id, { workspaceMode: 'worktree' }));
    expect(patched.value.workspaceMode).toBe('worktree');
    expect(getTask(store.db, task.id).workspaceMode).toBe('shared');
    expect(addTask(p.id).workspaceMode).toBe('worktree');
  });
});

describe('currentBatch', () => {
  const newBatch = (projectId: ProjectId, title: string, worktreePath?: string) =>
    store.write((ctx) =>
      insertBatch(ctx, {
        projectId,
        title,
        baseBranch: 'main',
        ...(worktreePath ? { worktreePath } : {}),
      }),
    ).value;
  const ship = (id: Parameters<typeof transitionBatch>[1]) => {
    for (const to of ['OPEN', 'SHIPPING', 'SHIPPED'] as const)
      store.write((ctx) => transitionBatch(ctx, id, { to }));
  };

  it('is the unfinished shared batch, never a newer copy', () => {
    const p = project();
    const shared = newBatch(p.id, 'Shared');
    const copy = newBatch(p.id, 'Copy', '/wt/copy');
    expect(currentBatch(store.db, p.id)?.id).toBe(shared.id);
    const view = listProjectViews(store.db).find((v) => v.id === p.id);
    expect(view?.currentBatch?.id).toBe(shared.id);
    expect(view?.openBatches.map((b) => b.id)).toEqual([copy.id, shared.id]);
  });

  it("is the newest finished batch when only a copy's batch is open", () => {
    const p = project();
    const shipped = newBatch(p.id, 'Shipped');
    ship(shipped.id);
    newBatch(p.id, 'Copy', '/wt/copy');
    expect(currentBatch(store.db, p.id)?.id).toBe(shipped.id);
  });

  it("is none when only a copy's batch exists", () => {
    const p = project();
    newBatch(p.id, 'Copy', '/wt/copy');
    expect(currentBatch(store.db, p.id)).toBeNull();
  });
});
