import { LinearEventKind, LinearPostState } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dropPendingLinearPosts,
  enqueueLinearPost,
  failLinearPosts,
  listLinearPosts,
  pendingLinearPosts,
  recordLinearPosts,
} from './linear-posts';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';
import { insertTask } from './tasks';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seed() {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  const enqueue = (dedupeKey: string) =>
    store.write((ctx) =>
      enqueueLinearPost(ctx, {
        taskId: task.id,
        projectId: project.id,
        event: LinearEventKind.Verdict,
        dedupeKey,
        attempt: 1,
        detail: {},
        dueAt: ctx.now,
      }),
    ).value;
  return { project, task, enqueue };
}

describe('the Linear post queue', () => {
  it('writes nothing for a repeated dedupe key', () => {
    const { task, enqueue } = seed();
    expect(enqueue('verdict:1')).not.toBeNull();
    expect(enqueue('verdict:1')).toBeNull();
    expect(listLinearPosts(store.db, task.id)).toHaveLength(1);
  });

  it('fails a row at its fifth try and clears its due time', () => {
    const { task, enqueue } = seed();
    const row = enqueue('verdict:1');
    if (row === null) throw new Error('not enqueued');
    for (let i = 0; i < 4; i += 1) {
      store.write((ctx) => {
        failLinearPosts(ctx, [row.id], 'down', ctx.now, 5);
      });
    }
    expect(listLinearPosts(store.db, task.id)[0]).toMatchObject({ state: 'pending', tries: 4 });
    store.write((ctx) => {
      failLinearPosts(ctx, [row.id], 'down', ctx.now, 5);
    });
    expect(listLinearPosts(store.db, task.id)[0]).toMatchObject({
      state: LinearPostState.Failed,
      tries: 5,
      dueAt: null,
    });
  });

  it('drops only pending rows of a project', () => {
    const { project, task, enqueue } = seed();
    const recorded = enqueue('a');
    const withheld = enqueue('b');
    const failed = enqueue('c');
    enqueue('d');
    if (recorded === null || withheld === null || failed === null) throw new Error('not enqueued');
    store.write((ctx) => {
      recordLinearPosts(ctx, [recorded.id], {
        state: 'recorded',
        commentIds: ['c1'],
        statusSet: null,
        attachmentUrl: null,
      });
      recordLinearPosts(ctx, [withheld.id], { state: 'withheld', pattern: 'aws_key' });
      failLinearPosts(ctx, [failed.id], 'down', ctx.now, 1);
    });
    const dropped = store.write((ctx) => dropPendingLinearPosts(ctx, { projectId: project.id }));
    expect(dropped.value).toBe(1);
    expect(pendingLinearPosts(store.db)).toHaveLength(0);
    expect(
      listLinearPosts(store.db, task.id)
        .map((r) => r.state)
        .sort(),
    ).toEqual(['failed', 'recorded', 'withheld']);
  });
});
