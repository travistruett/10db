import { BatchState, CopyStep, WorkstreamState, type BatchId, type TaskDto } from '@10db/contracts';
import {
  copyInProgressOf,
  getBatch,
  getLocalCopy,
  listWorkstreams,
  patchTask,
  transitionBatch,
  unfinishedCopyOf,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { recoverBatches } from './index';
import { subscribeCopyQueue } from './copy-queue';

let h: DeliveryHarness;
let unsubscribe: () => void;
beforeEach(() => {
  h = createDeliveryHarness(
    { delivery: 'local', localCopies: true, copyTeardownCommand: 'true', defaultRigor: 'standard' },
    { trigger: false },
  );
  unsubscribe = subscribeCopyQueue(h.bus, h.starter);
});
afterEach(() => {
  unsubscribe();
  h.close();
});

function inCopy(title: string, dependsOn: TaskDto['id'][] = []): TaskDto {
  const task = h.addTask(title, { dependsOn });
  h.store.write((w) => patchTask(w, task.id, { workspaceMode: 'worktree' }));
  return { ...task, workspaceMode: 'worktree' };
}

function runOf(task: TaskDto) {
  const run = listWorkstreams(h.store.db, {})
    .filter((w) => w.taskId === task.id)
    .at(-1);
  if (!run) throw new Error(`no run for ${task.title}`);
  return run;
}

/** Ends a copy the way a landing or an abandon does: its batch leaves the unfinished states. */
function end(batchId: BatchId, to: BatchState): void {
  h.state.write((w) => transitionBatch(w, batchId, { to, reason: 'test' }));
}

describe("a local project's copy tasks wait their turn", () => {
  it('queues a second copy task, then cuts it when the copy in progress ends, with no one starting it', async () => {
    const first = h.starter.startTask(inCopy('Alpha').id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, first.id).state).toBe(BatchState.Open);

    const beta = inCopy('Beta');
    const second = h.starter.startTask(beta.id);

    // Accepted and held: one copy of the project is in progress, the other waits and is not cut.
    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Cutting);
    expect(getLocalCopy(h.store.db, second.id)?.step).toBe(CopyStep.Queued);
    expect(runOf(beta).state).toBe(WorkstreamState.Queued);
    expect(copyInProgressOf(h.store.db, h.project.id)?.id).toBe(first.id);
    await h.jobs.idle();
    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Cutting);

    end(first.id, BatchState.Abandoned);
    await h.jobs.idle();

    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Open);
    expect(getLocalCopy(h.store.db, second.id)?.step).toBe(CopyStep.Open);
    expect(unfinishedCopyOf(h.store.db, h.project.id)?.id).toBe(second.id);
  });

  it('cuts the oldest waiting copy first, and only one at a time', async () => {
    const first = h.starter.startTask(inCopy('Alpha').id);
    await h.jobs.idle();
    const second = h.starter.startTask(inCopy('Beta').id);
    const third = h.starter.startTask(inCopy('Gamma').id);

    end(first.id, BatchState.Abandoned);
    await h.jobs.idle();

    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Open);
    expect(getLocalCopy(h.store.db, third.id)?.step).toBe(CopyStep.Queued);
  });

  it('puts a dependent of a waiting task in the same waiting copy', async () => {
    h.starter.startTask(inCopy('Alpha').id);
    await h.jobs.idle();
    const beta = inCopy('Beta');
    const gamma = inCopy('Gamma', [beta.id]);
    const second = h.starter.startTask(beta.id);
    const joined = h.starter.startTask(gamma.id);

    expect(joined.id).toBe(second.id);
    expect(listWorkstreams(h.store.db, { batchId: second.id }).map((w) => w.taskId)).toEqual([
      beta.id,
      gamma.id,
    ]);
  });

  it('keeps the queue through a restart, and cuts the next copy once its predecessor ended while down', async () => {
    const first = h.starter.startTask(inCopy('Alpha').id);
    await h.jobs.idle();
    const second = h.starter.startTask(inCopy('Beta').id);
    const restart = (): Promise<unknown> =>
      recoverBatches({
        jobs: h.jobs,
        folderHold: h.ctx.folderHold,
        state: h.state,
        git: h.git,
        inbox: h.inbox,
        processes: systemProcesses,
        shipper: h.shipper,
        starter: h.starter,
        logger: silentLogger,
        worktrees: { ctx: h.ctx, root: h.worktreeRoot },
      });

    await restart();
    await h.jobs.idle();
    // Recovery cuts a CUTTING row again, but not one that never began a cut.
    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Cutting);
    expect(getLocalCopy(h.store.db, second.id)?.step).toBe(CopyStep.Queued);

    unsubscribe();
    end(first.id, BatchState.Abandoned);
    await restart();
    h.starter.advanceCopyQueue();
    await h.jobs.idle();
    expect(getBatch(h.store.db, second.id).state).toBe(BatchState.Open);
  });

  it('drops a waiting copy whose task was cancelled, and goes on to the next', async () => {
    const first = h.starter.startTask(inCopy('Alpha').id);
    await h.jobs.idle();
    const beta = inCopy('Beta');
    const second = h.starter.startTask(beta.id);
    const third = h.starter.startTask(inCopy('Gamma').id);

    h.settle(runOf(beta).id, WorkstreamState.Cancelled);
    expect(() => getBatch(h.store.db, second.id)).toThrow();

    end(first.id, BatchState.Abandoned);
    await h.jobs.idle();
    expect(getBatch(h.store.db, third.id).state).toBe(BatchState.Open);
  });
});
