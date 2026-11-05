import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchDto, TaskDto } from '@10db/contracts';
import {
  getAppSetting,
  getBatch,
  getBatchRow,
  insertBatch,
  listBatches,
  listInbox,
  listWorkstreams,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { SANDBOXED, waitFor } from '../../test/fixtures';
import { alive, orphanGateGroup } from '../../test/orphan-gate';
import { ManualClock } from '../clock';
import { silentLogger } from '../log';
import { systemProcesses } from '../recovery';
import { createScheduler } from '../scheduler';
import { leftOutCards } from './cards';
import { raise } from './context';
import { cuttingTasksKey } from './cutting-tasks';
import { batchBranchName, createBatchStarter, recoverBatches, type DeliveryJobs } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    starter: h.starter,
    logger: silentLogger,
  });

/** An open batch of one task with one commit on its branch. */
async function openBatch(): Promise<BatchDto> {
  const task = h.addTask('Alpha');
  const started = h.only(
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] }),
  );
  await h.jobs.idle();
  h.commit('src/api/alpha.txt');
  return getBatch(h.store.db, started.id);
}

/** As if the daemon died just after the ship trigger moved the batch to SHIPPING. */
async function shippingAfterCrash(): Promise<BatchDto> {
  const batch = await openBatch();
  for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
  return h.state.write((c) => transitionBatch(c, batch.id, { to: 'SHIPPING' }));
}

function onOrigin(branch: string | null): string | null {
  try {
    return h.origin$('rev-parse', '--verify', '-q', `refs/heads/${branch ?? ''}`);
  } catch {
    return null;
  }
}

describe('recoverBatches', () => {
  it('offers Ship without it on a revert card that waited on a ship recovery fails', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await shippingAfterCrash();
    const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
    raise(
      h.inbox,
      h.project.id,
      leftOutCards.revertKept(
        batch,
        { workstreamId: ws.id, titles: ['Alpha'] },
        'a'.repeat(40),
        'a test',
        'SHIPPING',
      ),
    );
    const waiting = h.only(h.cards().filter((c) => c.title.includes('revert')));
    expect(waiting.options).toEqual([]);
    h.git$('switch', '-q', 'main');

    const report = await recover();

    expect(report.failed).toEqual([batch.id]);
    const again = h.only(h.cards().filter((c) => c.title.includes('revert')));
    expect(again.id).toBe(waiting.id);
    expect(again.body).not.toMatch(/nothing to answer/i);
    expect(again.options.map((o) => o.label)).toContain('Ship without it');
  });

  it('deletes a CUTTING row with a card, and leaves the branch a crash left behind; the next cut uses a new name', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const cutting = h.state.write((c) =>
      insertBatch(c, { projectId: h.project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    // The branch a crash just after `git switch` leaves behind, named for the CUTTING row.
    const leftover = batchBranchName(cutting.title, cutting.id);
    h.git$('switch', '-q', '-c', leftover);
    const report = await recover();
    expect(report.deleted).toHaveLength(1);
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.only(h.cards()).title).toBe(
      'Batch not started: 10db stopped while cutting the branch for "Greetings"',
    );
    expect(h.git$('branch', '--list', leftover)).toContain(leftover);
    const next = await openBatch();
    expect(next.state).toBe('OPEN');
    expect(next.branch).not.toBe(leftover);
    const batchBranches = h.git$('branch', '--list', '--format=%(refname:short)', '10db/*');
    expect(batchBranches.split('\n').sort()).toEqual([leftover, next.branch].sort());
  });

  /** The daemon stopped before the cut ran: the CUTTING row and its task's QUEUED workstream. */
  function interruptedCut(): { cutting: BatchDto; task: TaskDto } {
    const noJobs: DeliveryJobs = {
      run: () => undefined,
      idle: () => Promise.resolve(),
      pending: () => 0,
      stop: () => Promise.resolve(),
    };
    const task = h.addTask('Alpha');
    const cutting = h.only(
      createBatchStarter({ ...h.ctx, jobs: noJobs }).startBatch(h.project.id, {
        title: 'Greetings',
        taskIds: [task.id],
      }),
    );
    expect(listWorkstreams(h.store.db, { batchId: cutting.id })).toMatchObject([
      { taskId: task.id, state: 'QUEUED' },
    ]);
    return { cutting, task };
  }

  it('cuts a batch the restart interrupted again, with no card, and its task keeps its workstream', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { cutting, task } = interruptedCut();
    const [queued] = listWorkstreams(h.store.db, { batchId: cutting.id });
    const report = await recover();
    await h.jobs.idle();
    expect(report).toMatchObject({ recut: [cutting.id], deleted: [] });
    expect(h.cards()).toEqual([]);
    expect(getBatch(h.store.db, cutting.id)).toMatchObject({ state: 'OPEN', title: 'Greetings' });
    // The same workstream, still its task's: its place in line is kept.
    expect(listWorkstreams(h.store.db, {})).toMatchObject([
      { id: queued?.id, taskId: task.id, batchId: cutting.id },
    ]);
  });

  it('cuts it again after a branch the interrupted cut left, with nothing committed on it', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { cutting } = interruptedCut();
    // The cut made the branch and died before it switched to it.
    h.git$('branch', batchBranchName(cutting.title, cutting.id), 'main');
    await recover();
    await h.jobs.idle();
    expect(h.cards()).toEqual([]);
    expect(getBatch(h.store.db, cutting.id)).toMatchObject({
      state: 'OPEN',
      branch: batchBranchName(cutting.title, cutting.id),
    });
  });

  it('still raises its card when the cut again is refused for a real reason', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { cutting, task } = interruptedCut();
    writeFileSync(join(h.repo, 'untracked.txt'), 'in the way\n');
    h.git$('add', 'untracked.txt');
    await recover();
    await h.jobs.idle();
    expect(listBatches(h.store.db)).toEqual([]);
    expect(h.only(h.cards()).title).toContain('Batch not started');
    expect(h.only(h.cards()).title).not.toContain('10db stopped');
    expect(listWorkstreams(h.store.db, {})).toMatchObject([
      { taskId: task.id, state: 'CANCELLED', batchId: null },
    ]);
    expect(getAppSetting(h.store.db, cuttingTasksKey(cutting.id))).toBeUndefined();
  });

  it('closes the cut-interrupted card by itself once its task starts after the restart', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const { cutting, task } = interruptedCut();
    // The checkout is on the branch the cut made, so where it came from is lost: not cut again.
    h.git$('switch', '-q', '-c', batchBranchName(cutting.title, cutting.id));
    await recover();
    const card = h.only(h.cards());
    expect(card.title).toBe(
      'Batch not started: 10db stopped while cutting the branch for "Greetings"',
    );
    // Cancelled with the row, so the task can be started again.
    expect(listWorkstreams(h.store.db, {})).toMatchObject([
      { taskId: task.id, state: 'CANCELLED', batchId: null },
    ]);
    h.starter.startBatch(h.project.id, { title: 'Greetings', taskIds: [task.id] });
    await h.jobs.idle();
    expect(h.cards()).toEqual([]);
    expect(h.only(listInbox(h.store.db, { states: ['RESOLVED'] }))).toMatchObject({
      id: card.id,
      detail: { resolution: { by: '10db', reason: 'Alpha started' } },
    });
    expect(getAppSetting(h.store.db, cuttingTasksKey(cutting.id))).toBeUndefined();
  });

  it('fails an unfinished batch whose branch is not checked out, and launches nothing in it', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch();
    h.git$('switch', '-q', 'main');
    const report = await recover();
    expect(report.failed).toEqual([batch.id]);
    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'FAILED',
      failure: 'wrong_branch',
    });
    expect(h.only(h.cards()).title).toContain(
      `failed: checkout is on main, the batch branch is ${batch.branch ?? ''}`,
    );
    const launched: string[] = [];
    const scheduler = createScheduler({
      state: h.state,
      clock: new ManualClock(),
      caps: { global: 4 },
      instanceId: 'daemon-1',
      leaseMs: 60_000,
      tickMs: 2_000,
      logger: silentLogger,
      runner: {
        launch: (id) => {
          launched.push(id);
        },
        isRunning: () => false,
      },
      accounts: { blocked: () => null, isPaused: () => false, prepare: () => undefined },
      branches: h.git,
      onWrongBranch: () => undefined,
      onWorktreeMissing: () => undefined,
    });
    expect(await scheduler.tick()).toBe(0);
    await scheduler.idle();
    expect(launched).toEqual([]);
  });

  it.each<{ name: string; crash: (h: DeliveryHarness, batch: BatchDto) => void }>([
    { name: 'before step 0', crash: () => undefined },
    {
      name: 'after the gate passed',
      crash: (x, batch) => {
        x.state.write((c) => patchBatch(c, batch.id, { gateExitCode: 0 }));
      },
    },
    {
      name: 'after the push',
      crash: (x, batch) => {
        x.git$('push', '-q', '-u', 'origin', batch.branch ?? '');
      },
    },
    {
      name: 'after gh pr create, before SHIPPED was written',
      crash: (x, batch) => {
        x.git$('push', '-q', '-u', 'origin', batch.branch ?? '');
        const body = join(x.dataDir, 'body.md');
        writeFileSync(body, 'from the run that crashed\n');
        void x.gh.prCreate({
          repo: 'acme/widgets',
          base: 'main',
          head: batch.branch ?? '',
          title: 'feat(app): greetings',
          bodyFile: body,
        });
      },
    },
  ])(
    'finishes a batch left in SHIPPING $name with one PR and the same pushed SHA',
    async ({ crash }) => {
      h = createDeliveryHarness({}, { trigger: false });
      const batch = await shippingAfterCrash();
      crash(h, batch);
      const report = await recover();
      expect(report.resumed).toEqual([batch.id]);
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id)).toMatchObject({
        state: 'SHIPPED',
        prUrl: 'https://github.com/acme/widgets/pull/1',
      });
      expect(h.gh.calls.filter((c) => c.method === 'prCreate')).toHaveLength(1);
      expect(onOrigin(batch.branch)).toBe(h.git$('rev-parse', `refs/heads/${batch.branch ?? ''}`));
    },
  );

  // Identifies the process with `ps`, which is setuid: no sandbox can run it.
  it.skipIf(SANDBOXED)('terminates an orphaned shipping gate before re-running', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const gate = await orphanGateGroup();
    try {
      const batch = await shippingAfterCrash();
      h.state.write((c) =>
        patchBatch(c, batch.id, { gatePid: gate.pid, gatePidStart: gate.startedAt }),
      );
      await recover();
      await gate.exited;
      await waitFor(() => !alive(gate.grandchildPid));
      await h.jobs.idle();
      expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
    } finally {
      if (alive(gate.grandchildPid)) process.kill(gate.grandchildPid, 'SIGKILL');
      gate.cleanup();
    }
  });

  it('ships an open batch whose last workstream finished while the daemon was down', async () => {
    h = createDeliveryHarness({}, { trigger: false });
    const batch = await openBatch();
    for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
    expect(getBatch(h.store.db, batch.id).state).toBe('OPEN');
    await recover();
    await h.jobs.idle();
    expect(getBatch(h.store.db, batch.id).state).toBe('SHIPPED');
  });
});

describe('shutdown while shipping', () => {
  // Identifies the process with `ps`, which is setuid: no sandbox can run it.
  it.skipIf(SANDBOXED)(
    'kills the gate, records no result and leaves the batch SHIPPING',
    async () => {
      h = createDeliveryHarness({ gateCommand: 'sleep 30' });
      const batch = await openBatch();
      for (const ws of listWorkstreams(h.store.db, { batchId: batch.id })) h.settle(ws.id, 'DONE');
      const pid = await waitFor(() => getBatchRow(h.store.db, batch.id).gatePid ?? undefined);
      await h.jobs.stop();
      expect(getBatchRow(h.store.db, batch.id)).toMatchObject({
        state: 'SHIPPING',
        gatePid: null,
        gateExitCode: null,
      });
      expect(alive(pid)).toBe(false);
      expect(onOrigin(batch.branch)).toBeNull();
    },
  );
});
