import { WorkspaceMode } from '@10db/contracts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cancelRefusedStartTask,
  getBatch,
  getTask,
  getWorkstream,
  listWorkstreams,
  patchTask,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  // The ship trigger is on: the old batch keeps the superseded attempt until the new cut ends
  // (`members`), and the trigger is what checks it again then.
  h = createDeliveryHarness({}, { networkTimeoutMs: 60_000 });
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
    // The old batch no longer waits on the superseded attempt: the cut that ended moved it out of OPEN.
    expect(getBatch(h.store.db, batch.id).state).not.toBe('OPEN');
  });

  /**
   * Alpha and Beta share a batch; Beta is done and Alpha failed having committed nothing. Alpha then
   * moves to a separate copy and starts over there, and the copy's cut is refused (its install fails),
   * which leaves Alpha's latest run cancelled and detached from any batch.
   */
  async function startOverRefused() {
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    h.git$('push', '-q', 'origin', 'main');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
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
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    h.pnpm.failWith(1, 'install failed');

    startService().startTask(alpha.id, { fresh: true });
    await h.jobs.idle();

    const latestId = getTask(h.store.db, alpha.id).workstreamId;
    if (latestId === null) throw new Error('the start made a workstream');
    expect(getWorkstream(h.store.db, latestId)).toMatchObject({
      state: 'CANCELLED',
      batchId: null,
    });
    return { alpha, batchId: batch.id };
  }

  it('tells the builder why the batch waits when the copy’s cut was refused, and what to do', async () => {
    const { batchId } = await startOverRefused();

    const batch = getBatch(h.store.db, batchId);
    expect(batch.state).toBe('OPEN');
    const notice = h.only(batch.notices);
    expect(notice).toMatchObject({ key: 'superseded-attempt', tone: 'warning' });
    expect(notice.line).toContain('Alpha');
    expect(notice.body).toContain('start');
    expect(notice.body).toContain('Ship anyway');
  });

  it('lets the batch ship its other work once the builder closes the task', async () => {
    const { alpha, batchId } = await startOverRefused();

    h.state.write((w) => cancelRefusedStartTask(w, alpha.id));

    expect(getBatch(h.store.db, batchId).state).not.toBe('OPEN');
  });
});
