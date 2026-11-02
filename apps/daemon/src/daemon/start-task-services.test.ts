import { WorkspaceMode } from '@10db/contracts';
import { getBatch, listWorkstreams, patchTask } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  // The test moves batches by hand; the ship trigger would race it.
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/**
 * The daemon's task service. Only startTask runs here, and it reads the state store, the batch
 * starter, the shipper, the inbox and the scheduler, so those are the real ones (the scheduler a stub).
 */
function startService() {
  const wiring = {
    state: h.state,
    starter: h.starter,
    shipper: h.shipper,
    inbox: h.inbox,
    scheduler: { requestTick: () => undefined },
  };
  // A cast at a test boundary: startTask touches nothing else of the deps.
  return createServices(wiring as unknown as Parameters<typeof createServices>[0]);
}

describe('a fresh start of one task of a shared batch through the task service', () => {
  it('lets the batch it left ship its other work, as the start checks it', async () => {
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
    // The failed attempt committed nothing, and the task moved to a separate copy of its own.
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');

    const started = startService().startTask(alpha.id, { fresh: true });
    await h.jobs.idle();

    // The task started in a batch of its own.
    expect(started.kind).toBe('batch');
    if (started.kind !== 'batch') throw new Error('a batch was expected');
    expect(started.batch.id).not.toBe(batch.id);
    // The old batch no longer waits on the superseded attempt: the start moved it out of OPEN.
    expect(getBatch(h.store.db, batch.id).state).not.toBe('OPEN');
  });
});
