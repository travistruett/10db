import { WorkspaceMode } from '@10db/contracts';
import { getBatch, getTask, listWorkstreams, patchTask } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createFailedRestarts } from './restart';

let h: DeliveryHarness;
beforeEach(() => {
  // The ship trigger is on: it is what checks the batch a fresh start left once the new cut ends.
  h = createDeliveryHarness({}, { networkTimeoutMs: 60_000 });
});
afterEach(() => {
  h.close();
});

/** Holds the queue `key` until the returned release runs, so a job queued behind it stays pending. */
function hold(key: string): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.jobs.run(key, () => gate);
  return release;
}

/**
 * Alpha and Beta share a batch; Beta is done and Alpha failed. Alpha then moves to a separate copy
 * and starts over, as the daemon's start does: supersede, start, check the batch it left. The copy's
 * cut waits behind `hold` until the test lets it run.
 */
async function startedOver(opts: { refusedCut?: boolean } = {}) {
  const alpha = h.addTask('Alpha');
  const beta = h.addTask('Beta', { areas: ['ui'] });
  const [batch] = h.starter.startBatch(h.project.id, {
    title: 'Both',
    taskIds: [alpha.id, beta.id],
  });
  if (!batch) throw new Error('a batch is expected');
  await h.jobs.idle();
  const failed = listWorkstreams(h.store.db, { batchId: batch.id }).find(
    (w) => w.taskId === alpha.id,
  );
  const done = listWorkstreams(h.store.db, { batchId: batch.id }).find((w) => w.taskId === beta.id);
  if (!failed || !done) throw new Error('two workstreams expected');
  h.settle(done.id, 'DONE');
  h.settle(failed.id, 'FAILED');
  if (opts.refusedCut) h.gh.auth = 'signed_out';

  h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
  const release = hold(`${h.project.id}:cut`);
  const restarts = createFailedRestarts({
    state: h.state,
    starter: h.starter,
    shipper: h.shipper,
    inbox: h.inbox,
  });
  const left = restarts.supersede(alpha.id);
  const fresh = h.starter.startTask(alpha.id);
  if (left) h.shipper.checkBatch(left);
  return { alpha, batchId: batch.id, fresh, release };
}

describe('the batch a task started over from, while its copy is being cut', () => {
  it('waits for the cut: the attempt stays a member, so the batch is not shipped without it', async () => {
    const { batchId, fresh, release } = await startedOver();

    expect(getBatch(h.store.db, fresh.id).state).toBe('CUTTING');
    // Neither the start's own check nor any later one ships the batch while the copy may still be refused.
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    h.shipper.checkBatch(batchId);
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    release();
    await h.jobs.idle();
  });

  it('lets the batch ship its other work once the copy has been cut', async () => {
    const { batchId, fresh, release } = await startedOver();

    release();
    await h.jobs.idle();

    expect(getBatch(h.store.db, fresh.id).state).toBe('OPEN');
    expect(getBatch(h.store.db, batchId).state).not.toBe('OPEN');
  });

  it('is not shipped by a refused cut: the task shows the cancelled start and can start again', async () => {
    const { alpha, batchId, fresh, release } = await startedOver({ refusedCut: true });

    release();
    await h.jobs.idle();

    expect(() => getBatch(h.store.db, fresh.id)).toThrow();
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    const latest = listWorkstreams(h.store.db, {})
      .filter((w) => w.taskId === alpha.id)
      .at(-1);
    expect(latest).toMatchObject({ state: 'CANCELLED', batchId: null });
    expect(getTask(h.store.db, alpha.id).workstreamId).toBe(latest?.id);
  });
});
