import { ConflictError, mintId, WorkspaceMode, type WorkstreamId } from '@10db/contracts';
import {
  getBatch,
  getInboxItem,
  getTask,
  getWorkstream,
  insertToolOp,
  listWorkstreams,
  patchTask,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createFailedRestarts, type FailedRestarts } from './restart';

let h: DeliveryHarness;
let restarts: FailedRestarts;
beforeEach(() => {
  // These tests move batches by hand; the ship trigger would race them.
  h = createDeliveryHarness({}, { trigger: false });
  restarts = createFailedRestarts({
    state: h.state,
    starter: h.starter,
    shipper: h.shipper,
    inbox: h.inbox,
  });
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

  /**
   * Alpha and Beta share a batch; Beta finishes and Alpha fails, having committed through the
   * commit tool when `committed`. Alpha then moves to a separate copy and starts over there, and the
   * batch it left is checked for shipping, as the start does.
   */
  async function startedOverFromShared(committed: boolean) {
    const alpha = h.addTask('Alpha');
    const beta = h.addTask('Beta', { areas: ['ui'] });
    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [alpha.id, beta.id] }),
    );
    await h.jobs.idle();
    const [a, b] = listWorkstreams(h.store.db, { batchId: batch.id });
    if (!a || !b) throw new Error('two workstreams expected');
    if (committed) {
      const sha = h.commit('src/api/alpha.txt');
      h.state.write((w) => {
        insertToolOp(w, {
          workstreamId: a.id,
          sessionId: mintId('Session'),
          opId: 'op-alpha-commit',
          tool: 'commit',
          result: { sha, alreadyCommitted: false },
        });
      });
    }
    h.settle(b.id, 'DONE');
    h.settle(a.id, 'FAILED');

    // The task moved to a separate copy, so its fresh start makes a batch of its own.
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    const left = restarts.supersede(a.taskId);
    const [fresh] = h.starter.startBatch(h.project.id, {
      title: 'Alpha again',
      taskIds: [alpha.id],
    });
    await h.jobs.idle();
    expect(left).toBe(batch.id);
    expect(fresh?.id).not.toBe(batch.id);
    h.shipper.checkBatch(batch.id);
    return { batchId: batch.id };
  }

  it('lets the batch it left ship its other work on its own when the attempt committed nothing', async () => {
    const { batchId } = await startedOverFromShared(false);

    // The superseded attempt no longer holds the old batch open, and Ship anyway isn't needed.
    expect(getBatch(h.store.db, batchId).state).not.toBe('OPEN');
    expect(getBatch(h.store.db, batchId).notices).toEqual([]);
  });

  it('keeps the batch it left for Ship anyway, and says why, when the attempt left commits on it', async () => {
    const { batchId } = await startedOverFromShared(true);

    // The failed attempt's commits are unverified; they never ship without the builder seeing them.
    const batch = getBatch(h.store.db, batchId);
    expect(batch.state).toBe('OPEN');
    const notice = h.only(batch.notices);
    expect(notice).toMatchObject({ key: 'superseded-attempt', tone: 'warning' });
    expect(notice.line).toContain('Alpha');
    expect(notice.body).toContain('Ship anyway');
  });

  it('refuses to end the batch while a run in it is live', async () => {
    const { alpha, ws } = await failedAlone();
    h.running.add(ws.id);

    expect(() => {
      restarts.supersede(alpha.id);
    }).toThrow(ConflictError);
  });
});

describe('the failed card of a task that is started again', () => {
  /** The card the runner raises when the workstream fails. */
  function failedCard(ws: { id: WorkstreamId }) {
    return h.inbox.flag({
      projectId: h.project.id,
      workstreamId: ws.id,
      title: 'Workstream failed: Alpha',
      body: 'The gate failed',
    });
  }

  it('closes when the run continues', async () => {
    const { alpha, ws } = await failedAlone();
    const card = failedCard(ws);

    restarts.continueRun(alpha.id);

    expect(getInboxItem(h.store.db, card.id).state).not.toBe('OPEN');
  });

  it('closes when the task starts over', async () => {
    const { alpha, ws } = await failedAlone();
    const card = failedCard(ws);

    restarts.supersede(alpha.id);

    expect(getInboxItem(h.store.db, card.id).state).not.toBe('OPEN');
  });

  it('stays open when starting over is refused', async () => {
    const { alpha, ws } = await failedAlone();
    const card = failedCard(ws);
    h.running.add(ws.id);

    expect(() => {
      restarts.supersede(alpha.id);
    }).toThrow(ConflictError);

    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
  });

  it('stays open when starting over leaves a shared batch as it is', async () => {
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
    const card = failedCard(a);

    restarts.supersede(a.taskId);

    // supersede leaves the shared batch alone; the start that follows begins a new run and closes
    // the card (restart-failed-api.test.ts).
    expect(getInboxItem(h.store.db, card.id).state).toBe('OPEN');
  });
});

describe('a task whose placement no longer matches the batch its failed run is in', () => {
  it('is not moved while the task still has the placement its batch works in', async () => {
    const { alpha } = await failedAlone();

    expect(restarts.placementMoved(alpha.id)).toBe(false);
    expect(restarts.continueRun(alpha.id)).not.toBeNull();
  });

  it('is moved once the task is set to a separate copy, and continuing declines', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));

    expect(restarts.placementMoved(alpha.id)).toBe(true);
    // The retry would stay in the shared batch, in Your folder, whatever the badge says.
    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it('has nothing to move without a failed run', () => {
    const alpha = h.addTask('Alpha');
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));

    expect(restarts.placementMoved(alpha.id)).toBe(false);
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
