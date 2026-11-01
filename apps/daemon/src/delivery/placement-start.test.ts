import { ConflictError, WorkspaceMode, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  getTask,
  insertBatch,
  listBatches,
  listWorkstreams,
  patchProject,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { jobKey, JobQueue } from './index';

let h: DeliveryHarness;
beforeEach(() => {
  // A project whose default is Your folder: each task's own placement decides where it runs.
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

const shared = (title: string, opts: { dependsOn?: TaskDto['id'][] } = {}) =>
  h.addTask(title, { workspaceMode: WorkspaceMode.Shared, ...opts });
const copy = (title: string, opts: { dependsOn?: TaskDto['id'][] } = {}) =>
  h.addTask(title, { workspaceMode: WorkspaceMode.Worktree, ...opts });

/** The one batch a start answered. */
function one(batches: readonly BatchDto[]): BatchDto {
  const [only] = batches;
  if (only === undefined || batches.length !== 1) throw new Error('expected one batch');
  return only;
}

const ids = (...tasks: TaskDto[]) => tasks.map((t) => t.id);

describe('starting a mix of placements', () => {
  it('makes one shared batch and one batch per copy group, and answers all of them', async () => {
    const a = shared('Alpha');
    const b = copy('Beta');
    const c = copy('Gamma');
    const answered = h.starter.startBatch(h.project.id, {
      title: 'Mixed',
      taskIds: ids(a, b, c),
    });
    expect(answered).toHaveLength(3);
    const kinds = answered.map((batch) => batch.worktreePath !== null);
    expect(kinds.filter((copied) => !copied)).toHaveLength(1);
    expect(kinds.filter(Boolean)).toHaveLength(2);
    await h.jobs.idle();
    const now = answered.map((batch) => getBatch(h.store.db, batch.id));
    expect(now.map((batch) => batch.state)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    const tasksOf = (batch: BatchDto) =>
      listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId);
    const sharedBatch = now.find((batch) => batch.worktreePath === null);
    expect(sharedBatch && tasksOf(sharedBatch)).toEqual([a.id]);
    expect(
      now
        .filter((batch) => batch.worktreePath !== null)
        .flatMap(tasksOf)
        .sort(),
    ).toEqual([b.id, c.id].sort());
  });

  it('writes the placement each task started with', async () => {
    const a = shared('Alpha');
    const b = copy('Beta');
    h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) });
    await h.jobs.idle();
    expect(getTask(h.store.db, a.id).workspaceMode).toBe('shared');
    expect(getTask(h.store.db, b.id).workspaceMode).toBe('worktree');
  });

  it('starts by each task, not by the project default', async () => {
    h.state.write((w) => patchProject(w, h.project.id, { workspaceMode: WorkspaceMode.Worktree }));
    const a = shared('Alpha');
    const batch = one(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(a) }));
    expect(batch.worktreePath).toBeNull();
    await h.jobs.idle();
  });

  it('refuses the whole start when the shared part is refused, leaving no batch', () => {
    const open = h.state.write((w) => {
      const inserted = insertBatch(w, {
        projectId: h.project.id,
        title: 'Busy',
        baseBranch: 'main',
      });
      return transitionBatch(w, inserted.id, { to: 'OPEN' });
    });
    h.state.write((w) => transitionBatch(w, open.id, { to: 'SHIPPING' }));
    const a = shared('Alpha');
    const b = copy('Beta');
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) }),
    ).toThrow(/shipping/);
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(listWorkstreams(h.store.db, {}).map((w) => w.taskId)).toEqual([]);
  });

  it('refuses the whole start when the copy part has an unfinished dependency, leaving no batch', () => {
    const outside = shared('Outside');
    const a = shared('Alpha');
    const b = copy('Beta', { dependsOn: ids(outside) });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) }),
    ).toThrow(ConflictError);
    expect(listBatches(h.store.db)).toEqual([]);
    expect(listWorkstreams(h.store.db, {})).toEqual([]);
  });

  it('refuses a dependency between a shared task and a copy task, naming both and where each runs', () => {
    const a = shared('Alpha');
    const b = copy('Beta', { dependsOn: ids(a) });
    let message = '';
    try {
      h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Beta');
    expect(message).toContain('Alpha');
    expect(message).toContain('separate copy');
    expect(message).toContain('Your folder');
    expect(listBatches(h.store.db)).toEqual([]);
  });

  it('refuses the same dependency the other way round', () => {
    const a = copy('Alpha');
    const b = shared('Beta', { dependsOn: ids(a) });
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) }),
    ).toThrow(/Beta.*Your folder.*Alpha.*separate copy/s);
    expect(listBatches(h.store.db)).toEqual([]);
  });
});

describe('fix tasks', () => {
  it("a fix task started into a copy's batch takes the copy", async () => {
    const first = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(copy('Alpha')),
      }),
    );
    await h.jobs.idle();
    const fix = shared('Fix');
    const answered = h.starter.startBatch(h.project.id, {
      title: 'Fix',
      taskIds: ids(fix),
      batchId: first.id,
    });
    await h.jobs.idle();
    expect(answered.map((b) => b.id)).toEqual([first.id]);
    expect(getTask(h.store.db, fix.id).workspaceMode).toBe('worktree');
    expect(listWorkstreams(h.store.db, { batchId: first.id }).map((w) => w.taskId)).toContain(
      fix.id,
    );
  });

  it('a fix task started into the shared batch takes Your folder', async () => {
    const first = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(shared('Alpha')),
      }),
    );
    await h.jobs.idle();
    const fix = copy('Fix');
    h.starter.startBatch(h.project.id, {
      title: 'Fix',
      taskIds: ids(fix),
      batchId: first.id,
    });
    await h.jobs.idle();
    expect(getTask(h.store.db, fix.id).workspaceMode).toBe('shared');
    expect(listBatches(h.store.db)).toHaveLength(1);
  });
});

describe('queues', () => {
  it("a copy's cut does not wait behind a job in the shared batch's queue", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.jobs.run(jobKey({ projectId: h.project.id, worktreePath: null }, JobQueue.Cut), () => gate);
    const batch = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(copy('Alpha')),
      }),
    );
    // The copy's cut finishes while the shared queue is still held.
    for (let i = 0; i < 400 && getBatch(h.store.db, batch.id).state === 'CUTTING'; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    release();
    await h.jobs.idle();
  });

  it("a shared batch keeps the project's queue after the project's default changes", async () => {
    const batch = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(shared('Alpha')),
      }),
    );
    await h.jobs.idle();
    h.state.write((w) => patchProject(w, h.project.id, { workspaceMode: WorkspaceMode.Worktree }));
    expect(jobKey(getBatch(h.store.db, batch.id), JobQueue.Ship)).toBe(h.project.id);
    expect(jobKey(getBatch(h.store.db, batch.id), JobQueue.Cut)).toBe(h.project.id);
  });
});
