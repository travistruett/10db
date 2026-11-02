import { ConflictError, WorkspaceMode, type BatchDto, type TaskDto } from '@10db/contracts';
import { getBatch, getTask, transitionBatch } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { jobKey, JobQueue } from '../delivery';
import { createServices } from './services';

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({}, { trigger: false });
});
afterEach(() => {
  h.close();
});

/**
 * The daemon's task service. Only patchTask runs here, and it reads the state store and the batch
 * starter, so those are the real ones; the rest of the daemon's wiring is not built.
 */
function taskService() {
  const wiring = { state: h.state, starter: h.starter };
  // A cast at a test boundary: patchTask touches nothing else of the deps.
  return createServices(wiring as unknown as Parameters<typeof createServices>[0]);
}

const ids = (...tasks: TaskDto[]) => tasks.map((t) => t.id);

function one(batches: readonly BatchDto[]): BatchDto {
  const [only] = batches;
  if (only === undefined || batches.length !== 1) throw new Error('expected one batch');
  return only;
}

/** Holds the queue `key` until the returned release runs, so a job queued behind it stays pending. */
function hold(key: string): () => void {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.jobs.run(key, () => gate);
  return release;
}

describe('a placement patch through the task service during a pending join', () => {
  /** An OPEN shared batch of one task. */
  async function openShared(): Promise<BatchDto> {
    const batch = one(
      h.starter.startBatch(h.project.id, {
        title: 'Alpha',
        taskIds: ids(h.addTask('Alpha', { workspaceMode: WorkspaceMode.Shared })),
      }),
    );
    await h.jobs.idle();
    return getBatch(h.store.db, batch.id);
  }

  /** Starts Beta as a shared task into the OPEN shared batch, its queue held so the join stays pending. */
  async function pendingJoin() {
    const batch = await openShared();
    const beta = h.addTask('Beta', { workspaceMode: WorkspaceMode.Shared });
    const release = hold(jobKey(batch, JobQueue.Cut));
    h.starter.startBatch(h.project.id, { title: 'Beta', taskIds: ids(beta) });
    return { batch, beta, release };
  }

  it('answers a conflict and leaves the placement alone', async () => {
    const { beta, release } = await pendingJoin();
    await expect(
      taskService().patchTask(beta.id, { workspaceMode: WorkspaceMode.Worktree }),
    ).rejects.toThrow(ConflictError);
    await expect(
      taskService().patchTask(beta.id, { workspaceMode: WorkspaceMode.Worktree }),
    ).rejects.toThrow(/Beta.*joining/);
    expect(getTask(h.store.db, beta.id).workspaceMode).toBe(WorkspaceMode.Shared);
    release();
    await h.jobs.idle();
  });

  it('is accepted once the join refuses', async () => {
    const { batch, beta, release } = await pendingJoin();
    // The batch moves on before the join writes, so the join refuses and adds nothing.
    h.state.write((w) => transitionBatch(w, batch.id, { to: 'SHIPPING' }));
    release();
    await h.jobs.idle();
    const patched = await taskService().patchTask(beta.id, {
      workspaceMode: WorkspaceMode.Worktree,
    });
    expect(patched.workspaceMode).toBe(WorkspaceMode.Worktree);
    expect(getTask(h.store.db, beta.id).workspaceMode).toBe(WorkspaceMode.Worktree);
  });
});
