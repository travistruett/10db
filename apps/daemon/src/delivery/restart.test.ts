import {
  ConflictError,
  mintId,
  WorkspaceMode,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  closeTask,
  getBatch,
  getInboxItem,
  getTask,
  getWorkstream,
  insertLandingGroup,
  insertToolOp,
  listBatches,
  listBoardColumns,
  listWorkstreams,
  patchTask,
  schema,
  transitionBatch,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { createFailedRestarts, type FailedRestarts } from './restart';

let h: DeliveryHarness;
let restarts: FailedRestarts;
function boot(): void {
  // These tests move batches by hand; the ship trigger would race them.
  h = createDeliveryHarness({}, { trigger: false });
  restarts = createFailedRestarts({
    state: h.state,
    starter: h.starter,
    shipper: h.shipper,
    inbox: h.inbox,
  });
}
beforeEach(boot);
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

/** Alpha and Beta share a batch; Beta finished and Alpha failed. */
async function failedBesideOtherWork() {
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
  return { batchId: batch.id, ws: a };
}

/** The card the runner raises when the workstream fails. */
function failedCard(ws: { id: WorkstreamId }) {
  return h.inbox.flag({
    tier: 'ask',
    urgency: 'high',
    closesWhen: { by: 'answer' },
    projectId: h.project.id,
    workstreamId: ws.id,
    title: 'Workstream failed: Alpha',
    body: 'The gate failed',
  });
}

const cardState = (card: ReturnType<typeof failedCard>) => getInboxItem(h.store.db, card.id).state;

describe('a task whose latest run failed in an open batch', () => {
  it('is not moved while it keeps its placement, and continues in the batch: the same workstream is queued again, the commits stay and its failed card closes', async () => {
    const { alpha, batchId, ws, commit } = await failedAlone();
    const card = failedCard(ws);

    expect(restarts.placementMoved(alpha.id)).toBe(false);
    const retried = restarts.continueRun(alpha.id);

    expect(retried).toMatchObject({ id: ws.id, state: 'QUEUED', batchId });
    const batch = getBatch(h.store.db, batchId);
    expect(batch.state).toBe('OPEN');
    expect(h.git$('log', '--format=%H', batch.branch ?? 'missing')).toContain(commit);
    expect(listWorkstreams(h.store.db, { batchId })).toHaveLength(1);
    expect(cardState(card)).not.toBe('OPEN');
  });

  it('starts over by ending the batch that holds only that attempt, closing its failed card', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    const card = failedCard(ws);

    restarts.supersede(alpha.id);

    expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
    expect(cardState(card)).not.toBe('OPEN');
    await h.jobs.idle();
    // The task can now start in a batch of its own at the base branch.
    const fresh = h.only(
      h.starter.startBatch(h.project.id, { title: 'Alpha', taskIds: [alpha.id] }),
    );
    await h.jobs.idle();
    expect(fresh.id).not.toBe(batchId);
    expect(getBatch(h.store.db, fresh.id).state).toBe('OPEN');
  });

  it('leaves a batch that holds other work, and the failed card, as they are when the task starts over', async () => {
    const { batchId, ws } = await failedBesideOtherWork();
    const card = failedCard(ws);

    restarts.supersede(ws.taskId);

    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    // supersede leaves the shared batch alone; the start that follows begins a new run and closes
    // the card (restart-failed-api.test.ts).
    expect(cardState(card)).toBe('OPEN');
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

  it('refuses to end the batch while a run in it is live, and its failed card stays open', async () => {
    const { alpha, ws } = await failedAlone();
    const card = failedCard(ws);
    h.running.add(ws.id);

    expect(() => {
      restarts.supersede(alpha.id);
    }).toThrow(ConflictError);

    expect(cardState(card)).toBe('OPEN');
  });
});

describe('a failed run retried from its drawer or its card', () => {
  it('closes the failed card, so the run that fails again raises the only open one', async () => {
    const { ws } = await failedAlone();
    const card = failedCard(ws);

    h.starter.retry(ws.id);

    expect(cardState(card)).not.toBe('OPEN');
  });
});

describe('a task whose placement no longer matches the batch its failed run is in', () => {
  it('is moved once set to a separate copy: continuing declines, Retry is refused naming both places and Start over, and Retry runs once the task is set back', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));

    expect(restarts.placementMoved(alpha.id)).toBe(true);
    // The retry would stay in the shared batch, in Your folder, whatever the badge says.
    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');

    let refused: unknown;
    try {
      h.starter.retry(ws.id);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(ConflictError);
    expect(String(refused)).toMatch(/Alpha.*a separate copy.*Your folder.*Start over/);
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
    expect(getTask(h.store.db, alpha.id).workspaceMode).toBe('worktree');

    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Shared }));

    expect(h.starter.retry(ws.id)).toMatchObject({ id: ws.id, state: 'QUEUED', batchId });
  });

  it('answers a closed task that moved with the closed reason, not Start over', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    h.state.write((w) => closeTask(w, alpha.id));

    let refused: unknown;
    try {
      h.starter.retry(ws.id);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(ConflictError);
    expect(String(refused)).toMatch(/Alpha was closed/);
    expect(String(refused)).not.toMatch(/Start over/);
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it('answers a parked task that moved with the parked reason, not Start over', async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));
    const [column] = listBoardColumns(h.store.db, h.project.id);
    if (!column) throw new Error('a board column is expected');
    // Alpha is the project's only task, so the update needs no filter.
    h.store.db.update(schema.tasks).set({ boardColumnId: column.id }).run();

    let refused: unknown;
    try {
      h.starter.retry(ws.id);
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(ConflictError);
    expect(String(refused)).toMatch(/Alpha is parked; move it to Backlog or Ready/);
    expect(String(refused)).not.toMatch(/Start over/);
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
    expect(getBatch(h.store.db, batchId).state).toBe('OPEN');
  });

  it("is not continued once its batch has ended, and Retry after it moved keeps the store's own refusal", async () => {
    const { alpha, batchId, ws } = await failedAlone();
    h.shipper.abandon(batchId);

    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');

    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));

    expect(() => h.starter.retry(ws.id)).toThrow(/start the task again/);
  });
});

describe('a failed task of a landing that moved', () => {
  function landing(tasks: readonly TaskDto[]): void {
    h.state.write((w) =>
      insertLandingGroup(w, {
        projectId: h.project.id,
        title: 'Real areas',
        taskIds: tasks.map((t) => t.id),
      }),
    );
  }

  /** Alpha and Beta of one landing, in one batch, placed at `mode`; Beta done and Alpha failed. */
  async function failedBesideLandingWork(mode: WorkspaceMode) {
    const alpha = h.addTask('Alpha', { workspaceMode: mode });
    const beta = h.addTask('Beta', { areas: ['ui'], workspaceMode: mode });
    landing([alpha, beta]);
    const batch = h.only(
      h.starter.startBatch(h.project.id, { title: 'Both', taskIds: [alpha.id, beta.id] }),
    );
    await h.jobs.idle();
    const runs = listWorkstreams(h.store.db, { batchId: batch.id });
    const [a, b] = [
      runs.find((w) => w.taskId === alpha.id),
      runs.find((w) => w.taskId === beta.id),
    ];
    if (!a || !b) throw new Error('two workstreams expected');
    h.settle(b.id, 'DONE');
    h.settle(a.id, 'FAILED');
    return { alpha, batchId: batch.id, ws: a };
  }

  /** Alpha alone in its landing's batch, placed at `mode`, failed. */
  async function failedAloneInLanding(mode: WorkspaceMode) {
    const alpha = h.addTask('Alpha', { workspaceMode: mode });
    const beta = h.addTask('Beta', { areas: ['ui'], workspaceMode: mode });
    landing([alpha, beta]);
    const batch = h.only(h.starter.startBatch(h.project.id, { title: 'A', taskIds: [alpha.id] }));
    await h.jobs.idle();
    const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
    h.settle(ws.id, 'FAILED');
    return { alpha, batchId: batch.id, ws };
  }

  const move = (task: TaskDto, mode: WorkspaceMode) => {
    h.state.write((w) => patchTask(w, task.id, { workspaceMode: mode }));
  };

  it('is refused by Start and by Retry out of a batch with other work of the landing, naming the landing, before anything is written; and once that batch has failed, says the landing holds it', async () => {
    const rows = [
      {
        from: WorkspaceMode.Shared,
        to: WorkspaceMode.Worktree,
        words: /Alpha.*Real areas.*pull request.*Your folder/,
      },
      {
        from: WorkspaceMode.Worktree,
        to: WorkspaceMode.Shared,
        words: /Alpha.*Real areas.*pull request.*a separate copy/,
      },
    ];
    let last: Awaited<ReturnType<typeof failedBesideLandingWork>> | undefined;
    for (const [i, { from, to, words }] of rows.entries()) {
      if (i > 0) {
        h.close();
        boot();
      }
      const label = `from ${from}`;
      last = await failedBesideLandingWork(from);
      const { alpha, batchId, ws } = last;
      move(alpha, to);

      expect.soft(() => restarts.supersede(alpha.id), `${label}: Start`).toThrow(words);
      expect.soft(getTask(h.store.db, alpha.id).workspaceMode, label).toBe(to);
      expect.soft(getBatch(h.store.db, batchId).state, label).toBe('OPEN');
      expect.soft(getWorkstream(h.store.db, ws.id).state, label).toBe('FAILED');
      expect.soft(listBatches(h.store.db), label).toHaveLength(1);

      expect.soft(() => h.starter.retry(ws.id), `${label}: Retry`).toThrow(words);
      expect.soft(getWorkstream(h.store.db, ws.id).state, `${label}: Retry`).toBe('FAILED');
    }

    // The last row moved from a separate copy to Your folder: now its batch fails.
    if (!last) throw new Error('a row is expected');
    const { alpha, batchId } = last;
    h.state.write((w) =>
      transitionBatch(w, batchId, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );

    expect(() => restarts.supersede(alpha.id)).toThrow(/Real areas.*pull request.*a separate copy/);
    expect(getBatch(h.store.db, batchId).state).toBe('FAILED');
    // Two boots, each of which had the 60 s test timeout before the fold.
  }, 120_000);

  it('tells Retry to start over, then starts over in the new place, when its batch held only its attempt', async () => {
    const { alpha, batchId, ws } = await failedAloneInLanding(WorkspaceMode.Shared);
    move(alpha, WorkspaceMode.Worktree);

    expect(() => h.starter.retry(ws.id)).toThrow(/Start over/);
    expect(restarts.placementMoved(alpha.id)).toBe(true);
    restarts.supersede(alpha.id);
    expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
    await h.jobs.idle();
    const fresh = h.starter.startTask(alpha.id);
    await h.jobs.idle();

    expect(fresh.id).not.toBe(batchId);
    expect(getBatch(h.store.db, fresh.id).worktreePath).not.toBeNull();
    expect(getTask(h.store.db, alpha.id).workspaceMode).toBe('worktree');
    expect(getWorkstream(h.store.db, ws.id).state).toBe('FAILED');
  });

  it('starts over when its failed batch held only its attempt', async () => {
    const { alpha, batchId } = await failedAloneInLanding(WorkspaceMode.Worktree);
    h.state.write((w) =>
      transitionBatch(w, batchId, { to: 'FAILED', patch: { failure: 'gate_failed' } }),
    );
    move(alpha, WorkspaceMode.Shared);

    restarts.supersede(alpha.id);
    await h.jobs.idle();
    const fresh = h.starter.startTask(alpha.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
    expect(getBatch(h.store.db, fresh.id).worktreePath).toBeNull();
    expect(getTask(h.store.db, alpha.id).workspaceMode).toBe('shared');
  });

  it('starts over in the same place when it never moved and its batch held only its attempt', async () => {
    const { alpha, batchId } = await failedAloneInLanding(WorkspaceMode.Shared);

    restarts.supersede(alpha.id);

    expect(getBatch(h.store.db, batchId).state).toBe('ABANDONED');
  });

  it('retries as before when it never moved', async () => {
    const { alpha, batchId, ws } = await failedBesideLandingWork(WorkspaceMode.Shared);

    expect(restarts.placementMoved(alpha.id)).toBe(false);
    expect(restarts.continueRun(alpha.id)).toMatchObject({ id: ws.id, batchId });
  });
});

describe('a task with no failed run in an open batch', () => {
  it('has nothing to move, continue or end', () => {
    const alpha = h.addTask('Alpha');

    expect(restarts.continueRun(alpha.id)).toBeNull();
    expect(() => {
      restarts.supersede(alpha.id);
    }).not.toThrow();
    expect(getTask(h.store.db, alpha.id).workstreamId).toBeNull();

    h.state.write((w) => patchTask(w, alpha.id, { workspaceMode: WorkspaceMode.Worktree }));

    expect(restarts.placementMoved(alpha.id)).toBe(false);
  });
});
