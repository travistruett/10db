import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictError, WorkspaceMode, type BatchDto, type TaskDto } from '@10db/contracts';
import {
  getBatch,
  getTask,
  insertBatch,
  listBatches,
  listTasks,
  listWorkstreams,
  patchProject,
  patchTask,
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

/** Holds the queue `key` until the returned release runs, so a job queued behind it stays pending. */
function hold(key: string): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.jobs.run(key, () => gate);
  return release;
}

/** Settles once every job queued on `key` so far has run. */
function drained(key: string): Promise<void> {
  return new Promise((resolve) => {
    h.jobs.run(key, () => {
      resolve();
      return Promise.resolve();
    });
  });
}

/** The project's single queue, which a shared batch's cut and join run in. */
const sharedQueue = () => jobKey({ projectId: h.project.id, worktreePath: null }, JobQueue.Cut);

/** Moves the task to a separate copy, as the placement control does. */
const toCopy = (task: TaskDto) =>
  h.state.write((w) => patchTask(w, task.id, { workspaceMode: WorkspaceMode.Worktree }));

/** The message `run` throws, or null when it doesn't throw. */
function refusal(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

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
    const before = listTasks(h.store.db, h.project.id);
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'Mixed', taskIds: ids(a, b) }),
    ).toThrow(/shipping/);
    expect(listBatches(h.store.db)).toHaveLength(1);
    expect(listWorkstreams(h.store.db, {}).map((w) => w.taskId)).toEqual([]);
    expect(listTasks(h.store.db, h.project.id)).toEqual(before);
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
    const release = hold(sharedQueue());
    const batch = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(copy('Alpha')),
      }),
    );
    // The copy's own queue drains, so its cut has finished, while the shared queue is still held.
    await drained(jobKey(batch, JobQueue.Cut));
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

describe('Start closes the window in which a placement can change', () => {
  it("gives a new shared batch's tasks QUEUED workstreams as soon as the start answers", async () => {
    const release = hold(sharedQueue());
    const a = shared('Alpha');
    const batch = one(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(a) }));
    expect(getBatch(h.store.db, batch.id).state).toBe('CUTTING');
    const queued = () =>
      listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => [w.taskId, w.state]);
    expect(queued()).toEqual([[a.id, 'QUEUED']]);
    release();
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    expect(queued()).toEqual([[a.id, 'QUEUED']]);
  });

  it('refuses a placement change and a second start while the shared batch is CUTTING, and makes no copy', async () => {
    const release = hold(sharedQueue());
    const a = shared('Alpha');
    const batch = one(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(a) }));
    expect(() => toCopy(a)).toThrow(ConflictError);
    expect(getTask(h.store.db, a.id).workspaceMode).toBe('shared');
    expect(() => h.starter.startBatch(h.project.id, { title: 'Again', taskIds: ids(a) })).toThrow(
      /already running/,
    );
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([batch.id]);
    release();
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
  });

  it('cancels the workstreams of a refused shared cut, and the task can be moved and started again', async () => {
    writeFileSync(join(h.repo, 'scratch.txt'), 'uncommitted\n');
    const a = shared('Alpha');
    one(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(a) }));
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(listWorkstreams(h.store.db, {}).filter((w) => w.taskId === a.id)).toMatchObject([
      { state: 'CANCELLED', batchId: null },
    ]);
    toCopy(a);
    const again = one(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(a) }));
    expect(again.worktreePath).not.toBeNull();
    await h.jobs.idle();
    expect(getBatch(h.store.db, again.id).state).toBe('OPEN');
  });
});

describe('a pending join', () => {
  /** An OPEN shared batch of one task. */
  async function openShared(): Promise<BatchDto> {
    const batch = one(
      h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(shared('Alpha')) }),
    );
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  /** An OPEN copy's batch of one task. */
  async function openCopy(): Promise<BatchDto> {
    const batch = one(
      h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: ids(copy('Alpha')) }),
    );
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  const joins = [
    { name: 'a shared start into the OPEN batch', open: openShared, task: shared, fix: false },
    { name: 'a fix task sent with the shared batch', open: openShared, task: copy, fix: true },
    { name: "a fix task sent with a copy's batch", open: openCopy, task: shared, fix: true },
  ];

  /** Starts Beta into the row's batch with its queue held, so the join stays pending until release. */
  async function pendingJoin(row: (typeof joins)[number]) {
    const batch = await row.open();
    const beta = row.task('Beta');
    const release = hold(jobKey(batch, JobQueue.Cut));
    const answered = h.starter.startBatch(h.project.id, {
      title: 'Beta',
      taskIds: ids(beta),
      ...(row.fix ? { batchId: batch.id } : {}),
    });
    expect(answered.map((b) => b.id)).toEqual([batch.id]);
    return { batch, beta, release };
  }

  it.each(joins)('refuses a second start and a placement change: $name', async (row) => {
    const { batch, beta, release } = await pendingJoin(row);
    expect(
      refusal(() => {
        h.starter.refuseIfJoining(beta.id);
      }),
    ).toMatch(/Beta.*joining/);
    expect(
      refusal(() => h.starter.startBatch(h.project.id, { title: 'Again', taskIds: ids(beta) })),
    ).toMatch(/Beta.*joining/);
    expect(listBatches(h.store.db).map((b) => b.id)).toEqual([batch.id]);
    release();
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      beta.id,
    );
    // The join wrote, so the pending-join test lets the task go; its own run now holds it.
    expect(
      refusal(() => {
        h.starter.refuseIfJoining(beta.id);
      }),
    ).toBeNull();
  });

  it.each(joins)('allows both again once the join refuses: $name', async (row) => {
    const { batch, beta, release } = await pendingJoin(row);
    // The batch moves on before the join writes, so the join refuses and adds nothing.
    h.state.write((w) => transitionBatch(w, batch.id, { to: 'SHIPPING' }));
    release();
    await h.jobs.idle();
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).not.toContain(
      beta.id,
    );
    expect(
      refusal(() => {
        h.starter.refuseIfJoining(beta.id);
      }),
    ).toBeNull();
    toCopy(beta);
    const again = h.starter.startBatch(h.project.id, { title: 'Again', taskIds: ids(beta) });
    expect(again.map((b) => b.id)).not.toContain(batch.id);
    await h.jobs.idle();
  });
});
