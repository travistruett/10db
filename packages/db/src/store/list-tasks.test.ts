import {
  BatchState,
  TaskStatus,
  WorkstreamState as S,
  type BatchId,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertBatch, transitionBatch } from './batches';
import { insertLocalCopy } from './local-copies';
import type { Store } from './store';
import { getTask, insertTask, listTasks, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, transitionWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const first = { model: 'claude-sonnet-5-5', effort: 'medium' } as const;

describe('listTasks', () => {
  it('reads every task as getTask does, in a number of queries that does not grow with the tasks', () => {
    const project = seedProject(store);
    const task = (title: string, dependsOn: TaskId[] = []) =>
      store.write((ctx) =>
        insertTask(ctx, project.id, {
          title,
          acceptanceCriteria: ['x'],
          areas: ['api'],
          dependsOn,
        }),
      ).value.id;
    const copyBatch = (title: string): BatchId =>
      store.write((ctx) => {
        const batch = insertBatch(ctx, {
          projectId: project.id,
          title,
          baseBranch: 'main',
          worktreePath: `/tmp/${title}`,
        });
        return transitionBatch(ctx, batch.id, { to: BatchState.Open }).id;
      }).value;
    const finish = (taskId: TaskId, batchId: BatchId | null) => {
      const run = store.write((ctx) => insertWorkstream(ctx, taskId, { batchId, first })).value.id;
      for (const to of [S.Starting, S.Running, S.Verifying, S.Done])
        store.write((ctx) => transitionWorkstream(ctx, run, { to, fence: null }));
      store.write((ctx) => {
        setTaskStatus(ctx, taskId, TaskStatus.Done);
      });
    };
    const expectSameAsGetTask = () => {
      const listed = listTasks(store.db, project.id);
      expect(listed.map((t) => t.id).sort()).toEqual(tasks.slice().sort());
      expect(listed).toEqual(listed.map((t) => getTask(store.db, t.id)));
      return listed;
    };

    const dependency = task('A');
    const outside = task('B', [dependency]);
    const joined = task('C', [dependency]);
    const idle = task('D');
    const tasks = [dependency, outside, joined, idle];
    expect(expectSameAsGetTask().find((t) => t.id === outside)?.boardStatus).toBe('backlog');

    const copy = copyBatch('copy');
    store.write((ctx) => insertLocalCopy(ctx, { batchId: copy, teardownCommand: 'true' }));
    finish(dependency, copy);
    store.write((ctx) => insertWorkstream(ctx, joined, { batchId: copy, first }));
    store.write((ctx) => insertWorkstream(ctx, outside, { batchId: copyBatch('other'), first }));
    const afterCopy = expectSameAsGetTask();
    // A dependency in a copy that has not landed holds up a dependent outside it, not one inside it.
    expect(afterCopy.find((t) => t.id === outside)?.boardStatus).toBe('in_progress');

    store.write((ctx) => transitionBatch(ctx, copy, { to: BatchState.Shipping }));
    store.write((ctx) => transitionBatch(ctx, copy, { to: BatchState.Shipped }));
    expectSameAsGetTask();

    const queries = (): number => {
      const prepare = vi.spyOn(store.db.$client, 'prepare');
      listTasks(store.db, project.id);
      const count = prepare.mock.calls.length;
      prepare.mockRestore();
      return count;
    };
    const few = queries();
    expect(few).toBeGreaterThan(0);
    for (let n = 0; n < 12; n++) finish(task(`More ${String(n)}`, [dependency]), null);
    expect(queries()).toBe(few);
  });
});
