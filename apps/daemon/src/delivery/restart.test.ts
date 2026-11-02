import { ConflictError } from '@10db/contracts';
import { getBatch, getTask, getWorkstream, listWorkstreams } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createFailedRestarts, type FailedRestarts } from './restart';

let h: DeliveryHarness;
let restarts: FailedRestarts;
beforeEach(() => {
  // These tests move batches by hand; the ship trigger would race them.
  h = createDeliveryHarness({}, { trigger: false });
  restarts = createFailedRestarts({ state: h.state, starter: h.starter, shipper: h.shipper });
});
afterEach(() => {
  h.close();
});

/** Alpha started in a batch of its own, one commit on the branch, then failed. */
async function failedAlone() {
  const alpha = h.addTask('Alpha');
  const batch = h.only(h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] }));
  await h.jobs.idle();
  const commit = h.commit('src/api/alpha.txt');
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.settle(ws.id, 'FAILED');
  return { alpha, batchId: batch.id, ws, commit };
}

describe('a task whose latest run failed in an open batch', () => {
  it('continues in the batch: the same workstream is queued again and the commits stay', async () => {
    const { alpha, batchId, ws, commit } = await failedAlone();

    const retried = restarts.continueRun(alpha.id);

    expect(retried).toMatchObject({ id: ws.id, state: 'QUEUED', batchId });
    const batch = getBatch(h.store.db, batchId);
    expect(batch.state).toBe('OPEN');
    expect(h.git$('log', '--format=%H', batch.branch ?? 'missing')).toContain(commit);
    expect(listWorkstreams(h.store.db, { batchId })).toHaveLength(1);
  });

  it('starts over by ending the batch that holds only that attempt', async () => {
    const { alpha, batchId } = await failedAlone();

    restarts.supersede(alpha.id);

    expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
    await h.jobs.idle();
    // The task can now start in a batch of its own at the base branch.
    const fresh = h.only(
      h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] }),
    );
    await h.jobs.idle();
    expect(fresh.id).not.toBe(batchId);
    expect(getBatch(h.store.db, fresh.id).state).toBe('OPEN');
  });

  it('leaves a batch that holds other work as it is when the task starts over', async () => {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [alpha.id, beta.id] }),
    );
    await h.jobs.idle();
    const [a, b] = listWorkstreams(h.store.db, { batchId: batch.id });
    if (!a || !b) throw new Error('two workstreams expected');
    h.settle(b.id, 'DONE');
    h.settle(a.id, 'FAILED');

    restarts.supersede(a.taskId);

    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
  });

  it('refuses to end the batch while a run in it is live', async () => {
    const { alpha, ws } = await failedAlone();
    h.running.add(ws.id);

    expect(() => {
      restarts.supersede(alpha.id);
    }).toThrow(ConflictError);
  });
});

describe('a task with no failed run in an open batch', () => {
  it('has nothing to continue or end', () => {
    const alpha = h.addTask('Alpha');

    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(() => {
      restarts.supersede(alpha.id);
    }).not.toThrow();
    expect(getTask(h.store.db, alpha.id).workstreamId).toBeNull();
  });

  it('is not continued once its batch has ended', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.shipper.abandon(batchId);

    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
  });
});
