import {
  BatchState,
  TaskStatus,
  WorkstreamState as S,
  type BatchId,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertBatch, transitionBatch } from './batches';
import { insertLocalCopy } from './local-copies';
import type { Store } from './store';
import { dependenciesDone, insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, transitionWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const first = { model: 'claude-sonnet-5-5', effort: 'medium' } as const;

describe('dependenciesDone', () => {
  it('counts a dependency in an unlanded copy as done only for a dependent run in that copy', () => {
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
    const openBatch = (title: string): BatchId =>
      store.write((ctx) => {
        const batch = insertBatch(ctx, {
          projectId: project.id,
          title,
          baseBranch: 'main',
          worktreePath: `/tmp/${title}`,
        });
        return transitionBatch(ctx, batch.id, { to: BatchState.Open }).id;
      }).value;

    const dependency = task('A');
    const outside = task('B', [dependency]);
    const joined = task('C', [dependency]);
    const copy = openBatch('copy');
    store.write((ctx) => insertLocalCopy(ctx, { batchId: copy, teardownCommand: 'true' }));
    const run = store.write((ctx) => insertWorkstream(ctx, dependency, { batchId: copy, first }))
      .value.id;
    for (const to of [S.Starting, S.Running, S.Verifying, S.Done])
      store.write((ctx) => transitionWorkstream(ctx, run, { to, fence: null }));
    store.write((ctx) => {
      setTaskStatus(ctx, dependency, TaskStatus.Done);
    });

    expect(dependenciesDone(store.db, outside)).toBe(false);

    const other = openBatch('other');
    store.write((ctx) => insertWorkstream(ctx, outside, { batchId: other, first }));
    expect(dependenciesDone(store.db, outside)).toBe(false);

    store.write((ctx) => insertWorkstream(ctx, joined, { batchId: copy, first }));
    expect(dependenciesDone(store.db, joined)).toBe(true);

    store.write((ctx) => transitionBatch(ctx, copy, { to: BatchState.Shipping }));
    store.write((ctx) => transitionBatch(ctx, copy, { to: BatchState.Shipped }));
    expect(dependenciesDone(store.db, outside)).toBe(true);
  });
});
