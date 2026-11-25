import { getBatch, getLocalCopy, listWorkstreams, patchTask, transitionBatch } from '@10db/db';
import { WorkstreamState, type TaskDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness(
    {
      delivery: 'local',
      localCopies: true,
      copyTeardownCommand: 'true',
      defaultRigor: 'standard',
    },
    { trigger: false },
  );
});
afterEach(() => {
  h.close();
});

/** A task the builder placed in a separate copy once it existed, as the placement control does. */
function inCopy(title: string): TaskDto {
  const task = h.addTask(title);
  h.store.write((w) => patchTask(w, task.id, { workspaceMode: 'worktree' }));
  return { ...task, workspaceMode: 'worktree' };
}

describe('a local project with a separate copy', () => {
  it('takes a fix task into its failed copy batch and reopens it, and refuses any other batch start', async () => {
    const first = inCopy('Alpha');
    const batch = h.starter.startTask(first.id);
    await h.jobs.idle();
    const [run] = listWorkstreams(h.store.db, { batchId: batch.id });
    if (!run) throw new Error('no workstream');
    h.settle(run.id, WorkstreamState.Done);
    h.store.write((w) =>
      transitionBatch(w, batch.id, {
        to: 'FAILED',
        patch: { failure: 'gate_failed' },
        reason: 'test',
      }),
    );

    const fix = inCopy('Alpha fix');
    expect(() => h.starter.startBatch(h.project.id, { title: 'x', taskIds: [fix.id] })).toThrow(
      /delivers locally/,
    );
    expect(() =>
      h.starter.startBatch(h.project.id, { title: 'x', taskIds: [fix.id], batchId: batch.id }),
    ).not.toThrow();
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    expect(listWorkstreams(h.store.db, { batchId: batch.id }).map((w) => w.taskId)).toContain(
      fix.id,
    );
    expect(getLocalCopy(h.store.db, batch.id)).toMatchObject({ step: 'open', attempt: 0 });
  });
});
