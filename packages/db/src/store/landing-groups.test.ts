import { BatchState, ConflictError, type TaskInput } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertBatch, landingBatches, transitionBatch } from './batches';
import { getLandingGroup, insertLandingGroup, listLandingGroups } from './landing-groups';
import type { Store } from './store';
import { getTask, insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const TASK: TaskInput = { title: 'T', acceptanceCriteria: ['c'], areas: ['api'] };

function twoTasks() {
  const project = seedProject(store);
  const [a, b] = store.write((ctx) => [
    insertTask(ctx, project.id, { ...TASK, title: 'A' }),
    insertTask(ctx, project.id, { ...TASK, title: 'B' }),
  ]).value;
  if (!a || !b) throw new Error('no tasks');
  return { project, a, b };
}

describe('landing groups', () => {
  it('writes the group and sets its tasks, and a task with none reads null', () => {
    const { project, a, b } = twoTasks();
    const group = store.write((ctx) =>
      insertLandingGroup(ctx, {
        projectId: project.id,
        title: 'Real areas',
        taskIds: [a.id],
      }),
    ).value;
    expect(getLandingGroup(store.db, group.id)).toMatchObject({
      title: 'Real areas',
      projectId: project.id,
      shapeId: null,
    });
    expect(getTask(store.db, a.id).landingGroupId).toBe(group.id);
    expect(getTask(store.db, b.id).landingGroupId).toBeNull();
    expect(listLandingGroups(store.db, project.id).map((g) => g.id)).toEqual([group.id]);
  });

  it('refuses a task that is already in a group, and writes nothing', () => {
    const { project, a, b } = twoTasks();
    store.write((ctx) =>
      insertLandingGroup(ctx, { projectId: project.id, title: 'One', taskIds: [a.id] }),
    );
    expect(() =>
      store.write((ctx) =>
        insertLandingGroup(ctx, { projectId: project.id, title: 'Two', taskIds: [b.id, a.id] }),
      ),
    ).toThrow(ConflictError);
    expect(listLandingGroups(store.db, project.id)).toHaveLength(1);
    expect(getTask(store.db, b.id).landingGroupId).toBeNull();
  });

  it("finds the batches the group's tasks ran in, newest first, once each", () => {
    const { project, a, b } = twoTasks();
    const group = store.write((ctx) =>
      insertLandingGroup(ctx, { projectId: project.id, title: 'One', taskIds: [a.id, b.id] }),
    ).value;
    expect(landingBatches(store.db, group.id)).toEqual([]);
    const batch = store.write((ctx) => {
      const made = insertBatch(ctx, {
        projectId: project.id,
        title: 'Batch',
        baseBranch: project.baseBranch,
        worktreePath: '/tmp/wt',
      });
      insertWorkstream(ctx, a.id, { batchId: made.id });
      insertWorkstream(ctx, b.id, { batchId: made.id });
      return made;
    }).value;
    expect(landingBatches(store.db, group.id).map((x) => x.id)).toEqual([batch.id]);
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: BatchState.Open }));
    expect(landingBatches(store.db, group.id)[0]?.state).toBe(BatchState.Open);
  });
});
