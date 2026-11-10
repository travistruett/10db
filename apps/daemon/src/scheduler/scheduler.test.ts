import { createDeliveryJobs } from '../delivery';
import { rmSync } from 'node:fs';
import {
  mintId,
  REVERTED_NOTICE_KEY,
  type AccountId,
  type BatchId,
  type BatchState,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  countLanes,
  insertPass,
  countMidSession,
  createTestStore,
  listBoardColumns,
  listInbox,
  patchAccount,
  recordAccountSecret,
  seedAccount,
  moveTask,
  getWorkstream,
  getWorkstreamRow,
  advanceTakeOut,
  endPassTurn,
  insertBatch,
  insertBuilderMessage,
  insertPassTurn,
  insertSession,
  insertTakeOut,
  insertTask,
  insertWorkstream,
  leavePass,
  markTaskMessagesDelivered,
  patchBatch,
  patchWorkstream,
  settlePassTurn,
  releaseClaims,
  runNext,
  schema,
  seedProject,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedSpend, tempDir, waitFor, type TempDir } from '../../test/fixtures';
import {
  createAccountPauses,
  createAccountRuntime,
  createModelListWait,
  MODEL_LIST_WAIT_MS,
  type AccountPauses,
  type ModelListWait,
  type AccountRuntime,
} from '../accounts';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, GitTrustError } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { recoverOnStartup, systemProcesses } from '../recovery';
import { createSelfUpdate } from '../self-update';
import { createScheduler } from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let launched: { id: WorkstreamId; fence: number }[];
/** The warm sessions the scheduler asked the runner to close. */
let closed: WorkstreamId[];
let inbox: InboxService;
let pauses: AccountPauses;
let accounts: AccountRuntime;
let running: Set<WorkstreamId>;
let branchOf: Map<string, string | null>;
/** Checkouts whose git the daemon refuses; their refusal raised its own card. */
let refusedRepos: Set<string>;
let branchReads: string[];
/** While set, a branch read waits for it: a tick stays inside `branchSnapshot`. */
let branchGate: Promise<void> | null;
let prepared: { accountId: AccountId; projectId: ProjectId }[];
/** The accounts the scheduler asked to have their model list read, as a session was about to start on them. */
let listed: AccountId[];
let wrongBranch: { batchId: string; current: string | null }[];
let wrongBranchAt: string[];
let missing: { batchId: string; path: string }[];
/** Whether the Mac is overloaded, as the scheduler's `held` reads it. */
let held: boolean;
/** The account whose browser sign-in holds the slot, as the scheduler's `connecting` reads it. */
let connecting: AccountId | null;
/** Holds an account's queued work while its model profiles are missing, as the runner does. */
let modelWait: ModelListWait;

beforeEach(() => {
  held = false;
  connecting = null;
  clock = new ManualClock(new Date(2026, 9, 20, 12));
  ({ store, close } = createTestStore(() => clock.now()));
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: () => Promise.resolve(),
    onResume: () => undefined,
  });
  modelWait = createModelListWait({
    db: store.db,
    clock,
    inbox,
    logger: silentLogger,
    onReleased: () => undefined,
  });
  accounts = createAccountRuntime({ state, clock, inbox, pauses, defaultPauseMs: 30 * 60_000 });
  launched = [];
  closed = [];
  running = new Set();
  branchOf = new Map();
  refusedRepos = new Set();
  branchReads = [];
  branchGate = null;
  wrongBranch = [];
  wrongBranchAt = [];
  missing = [];
  prepared = [];
  listed = [];
});
afterEach(() => {
  close();
});

function scheduler(caps = { global: 4 }, awaited: ReadonlySet<WorkstreamId> = new Set()) {
  return createScheduler({
    state,
    clock,
    caps,
    awaitedHolders: () => awaited,
    held: () => held,
    modelWait,
    connecting: () => (connecting === null ? null : { accountId: connecting }),
    instanceId: 'daemon-1',
    leaseMs: 60_000,
    tickMs: 2_000,
    logger: silentLogger,
    runner: {
      launch: (id, fence) => {
        launched.push({ id, fence });
      },
      isRunning: (id) => running.has(id),
      closeWarm: (id) => {
        closed.push(id);
        return Promise.resolve();
      },
    },
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        prepared.push({ accountId: account.id, projectId });
      },
      readList: (id) => {
        listed.push(id);
      },
    },
    branches: {
      currentBranch: (repo) => {
        branchReads.push(repo);
        if (refusedRepos.has(repo))
          return Promise.reject(
            new GitTrustError(repo, {
              kind: 'moved',
              pinned: '/a/.git',
              found: '/b/.git',
              pin: {
                gitDir: '/a/.git',
                commonDir: '/a/.git',
                id: '1:2/1:2',
                fetchUrl: null,
                pushUrl: null,
              },
              candidate: {
                gitDir: '/b/.git',
                commonDir: '/b/.git',
                id: '1:2/1:2',
                fetchUrl: null,
                pushUrl: null,
              },
            }),
          );
        return (branchGate ?? Promise.resolve()).then(() => branchOf.get(repo) ?? null);
      },
    },
    onWrongBranch: (batch, current, checkout) => {
      wrongBranch.push({ batchId: batch.id, current });
      wrongBranchAt.push(checkout);
    },
    onWorktreeMissing: (batch, path) => {
      missing.push({ batchId: batch.id, path });
    },
  });
}

function queue(
  projectOverrides = {},
  areas = ['api'],
  dependsOn: Parameters<typeof insertTask>[2]['dependsOn'] = [],
) {
  const project = seedProject(store, projectOverrides);
  return add(project, areas, dependsOn);
}
function add(
  project: ReturnType<typeof seedProject>,
  areas: string[],
  dependsOn: Parameters<typeof insertTask>[2]['dependsOn'] = [],
) {
  const task = state.write((ctx) =>
    insertTask(ctx, project.id, { title: 't', acceptanceCriteria: ['x'], areas, dependsOn }),
  );
  return {
    project,
    task,
    workstream: state.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ),
  };
}

function pause(project: ReturnType<typeof seedProject>): void {
  pauses.pause(
    project.accountId,
    { reason: 'usage_limit', until: new Date(clock.now().getTime() + 60_000) },
    {
      projectId: project.id,
      card: { title: 't', body: 'b', foldKey: 'k', detail: {} },
    },
  );
}

function moveWorkstream(id: WorkstreamId, to: 'STARTING' | 'FAILED' | 'CANCELLED' | 'QUEUED') {
  state.write((ctx) => transitionWorkstream(ctx, id, { to, fence: null }));
}

describe('scheduler', () => {
  it('launches nothing while held, queued work and awaited holders alike, and launches it once released', async () => {
    const waiting = queue();
    queue();
    held = true;
    const s = scheduler({ global: 4 }, new Set([waiting.workstream.id]));
    expect(await s.tick()).toBe(0);
    expect(launched).toEqual([]);
    held = false;
    expect(await s.tick()).toBe(2);
  });

  it('leaves the queued work of an account waiting for its model list alone, and launches it once the wait ends', async () => {
    const keyed = seedAccount(store, { kind: 'anthropic_api_key', label: 'Keyed' });
    state.write((ctx) => recordAccountSecret(ctx, keyed.id, 'sha256:0000000000000000'));
    const waiting = queue();
    const other = queue({ accountId: keyed.id });
    modelWait.hold({ id: waiting.project.accountId, label: 'Waiting' }, waiting.project.id);
    const s = scheduler();
    expect(await s.tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([other.workstream.id]);
    // The held row is not claimed on any later tick either: it stays QUEUED, with no state changes.
    expect(await s.tick()).toBe(0);
    expect(getWorkstream(store.db, waiting.workstream.id).state).toBe('QUEUED');
    clock.advance(MODEL_LIST_WAIT_MS);
    expect(await s.tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([other.workstream.id, waiting.workstream.id]);
  });

  it('starts nothing on the account whose sign-in is under way, only there, and starts it once the sign-in is over', async () => {
    const sub = seedAccount(store, { kind: 'anthropic_api_key', label: 'Signing in' });
    state.write((ctx) => recordAccountSecret(ctx, sub.id, 'sha256:0000000000000000'));
    const signingIn = queue({ accountId: sub.id });
    const other = queue();
    connecting = sub.id;
    const s = scheduler();
    expect(await s.tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([other.workstream.id]);
    connecting = null;
    expect(await s.tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([other.workstream.id, signingIn.workstream.id]);
  });

  it('respects the global cap', async () => {
    queue();
    queue();
    queue();
    expect(await scheduler({ global: 2 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  describe('run next', () => {
    const press = (taskId: Parameters<typeof runNext>[1]) => {
      clock.advance(1_000);
      state.write((ctx) => runNext(ctx, taskId));
    };

    it('gives the one free lane to the task the builder put first, not the oldest', async () => {
      const a = queue();
      const b = queue();
      const c = queue();
      press(c.task.id);
      expect(await scheduler({ global: 1 }).tick()).toBe(1);
      expect(launched.map((l) => l.id)).toEqual([c.workstream.id]);
      // Once it holds a lane it no longer jumps the line: the rest keep the order they started in.
      expect(getWorkstream(store.db, c.workstream.id).runNextAt).toBeNull();
      moveWorkstream(c.workstream.id, 'CANCELLED');
      launched = [];
      await scheduler({ global: 1 }).tick();
      expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
      expect(getWorkstream(store.db, b.workstream.id).state).toBe('QUEUED');
    });

    describe('after a restart', () => {
      const restart = () =>
        recoverOnStartup({
          state,
          inbox,
          git: createGit(),
          processes: systemProcesses,
          jobs: createDeliveryJobs(silentLogger),
          clock: clock,
          maxRecoveryAttempts: 3,
          logger: silentLogger,
          cleanShutdown: true,
        });
      const interrupt = (id: WorkstreamId) => {
        moveWorkstream(id, 'STARTING');
        state.write((ctx) => transitionWorkstream(ctx, id, { to: 'RUNNING', fence: null }));
      };

      it('launches the workstream that was mid-session before tasks that never started, though it started after them', async () => {
        const a = queue();
        const b = queue();
        clock.advance(1_000);
        const interrupted = queue();
        interrupt(interrupted.workstream.id);

        const report = await restart();
        expect(report.requeued).toEqual([interrupted.workstream.id]);

        expect(await scheduler({ global: 1 }).tick()).toBe(1);
        expect(launched.map((l) => l.id)).toEqual([interrupted.workstream.id]);
        expect(getWorkstream(store.db, a.workstream.id).state).toBe('QUEUED');
        expect(getWorkstream(store.db, b.workstream.id).state).toBe('QUEUED');
        // The place is used up like a press: when it is queued again it waits in start order.
        expect(getWorkstream(store.db, interrupted.workstream.id).runNextAt).toBeNull();
      });

      it('keeps several interrupted workstreams in the order they started', async () => {
        const fresh = queue();
        const first = queue();
        clock.advance(1_000);
        const second = queue();
        clock.advance(1_000);
        const third = queue();
        for (const w of [third, first, second]) interrupt(w.workstream.id);

        await restart();

        await scheduler({ global: 4 }).tick();
        expect(launched.map((l) => l.id)).toEqual([
          first.workstream.id,
          second.workstream.id,
          third.workstream.id,
          fresh.workstream.id,
        ]);
      });

      it('still lets a press after the restart go ahead of a recovered workstream', async () => {
        const chosen = queue();
        clock.advance(1_000);
        const interrupted = queue();
        interrupt(interrupted.workstream.id);
        await restart();

        clock.advance(1_000);
        press(chosen.task.id);

        await scheduler({ global: 2 }).tick();
        expect(launched.map((l) => l.id)).toEqual([
          chosen.workstream.id,
          interrupted.workstream.id,
        ]);
      });
    });

    it('takes the latest press first when several tasks were pushed', async () => {
      const a = queue();
      const b = queue();
      queue();
      press(a.task.id);
      press(b.task.id);
      await scheduler({ global: 2 }).tick();
      expect(launched.map((l) => l.id)).toEqual([b.workstream.id, a.workstream.id]);
    });

    it('lets the next task run while the pushed one waits for its dependencies', async () => {
      const first = queue();
      const blocked = add(first.project, ['ui'], [first.task.id]);
      const other = queue();
      press(blocked.task.id);
      await scheduler({ global: 1 }).tick();
      // The pushed task isn't ready, so it takes no lane; the dependency it waits on goes first.
      expect(launched.map((l) => l.id)).toEqual([first.workstream.id]);
      expect(getWorkstream(store.db, other.workstream.id).state).toBe('QUEUED');
    });
  });

  it('respects a project lane limit and the account lane cap', async () => {
    const a = queue({ maxLanes: 1 });
    add(a.project, ['ui']);
    queue();
    queue();
    state.write((ctx) => patchAccount(ctx, a.project.accountId, { laneCap: 2 }));
    expect(await scheduler().tick()).toBe(2);
    expect(
      launched
        .map((l) => getWorkstreamRow(store.db, l.id).projectId)
        .filter((p) => p === a.project.id),
    ).toHaveLength(1);
  });

  it('leaves PAUSED_LIMIT work alone while its account is paused', async () => {
    const a = queue();
    const s = scheduler();
    await s.tick();
    pause(a.project);
    state.write((ctx) => {
      transitionWorkstream(ctx, a.workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    launched = [];
    await s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');
    expect(launched).toEqual([]);
  });

  it('re-queues PAUSED_LIMIT work that outlived its account pause', async () => {
    const a = queue();
    const s = scheduler();
    await s.tick();
    pause(a.project);
    // The runner writes PAUSED_LIMIT after the pause's reset timer already fired.
    clock.advance(60_000);
    state.write((ctx) => {
      transitionWorkstream(ctx, a.workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    launched = [];

    running.add(a.workstream.id);
    await s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');

    running.clear();
    await s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
  });

  it('re-queues work whose account pause ended unnoticed, without a second transition', async () => {
    const a = queue();
    const s = scheduler();
    await s.tick();
    pause(a.project);
    state.write((ctx) => {
      transitionWorkstream(ctx, a.workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    // The machine slept through the pause's timer.
    pauses.stop();
    clock.advance(120_000);
    launched = [];
    await s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
  });

  it('leaves queued work of a parked task alone', async () => {
    const { project, task, workstream: first } = queue();
    moveWorkstream(first.id, 'STARTING');
    moveWorkstream(first.id, 'FAILED');
    const second = state.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    moveWorkstream(second.id, 'CANCELLED');
    const column = listBoardColumns(store.db, project.id)[0];
    if (!column) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, task.id, { to: column.id, after: null, before: null }));
    // The retry route refuses this; the scheduler holds the line if a queue entry gets here anyway.
    moveWorkstream(first.id, 'QUEUED');
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, first.id).state).toBe('QUEUED');
  });

  it('launches a queued task a running task waits on for a claim, over every lane cap', async () => {
    const first = queue({ maxLanes: 2 });
    const second = add(first.project, ['api']);
    const holder = add(first.project, ['ui']);
    state.write((ctx) => patchAccount(ctx, first.project.accountId, { laneCap: 2 }));
    // Both lanes are held by tasks that wait inside request_claim for a claim the holder keeps.
    moveWorkstream(first.workstream.id, 'STARTING');
    moveWorkstream(second.workstream.id, 'STARTING');
    expect(await scheduler({ global: 2 }).tick()).toBe(0);
    expect(await scheduler({ global: 2 }, new Set([holder.workstream.id])).tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([holder.workstream.id]);
    expect(getWorkstream(store.db, holder.workstream.id).state).toBe('STARTING');
  });

  it('waits for dependencies', async () => {
    const a = queue();
    add(a.project, ['ui'], [a.task.id]);
    await scheduler().tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
  });

  it('serializes workstreams that claim the same area', async () => {
    const a = queue();
    const b = add(a.project, ['api']);
    const s = scheduler();
    await s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    state.write((ctx) => {
      for (const to of ['RUNNING', 'VERIFYING', 'DONE'] as const)
        transitionWorkstream(ctx, a.workstream.id, { to, fence: null });
      releaseClaims(ctx, a.workstream.id);
    });
    await s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id, b.workstream.id]);
  });

  it("skips a paused account's work", async () => {
    const a = queue();
    pause(a.project);
    expect(await scheduler().tick()).toBe(0);
  });

  it('ignores requestTick until it is started', async () => {
    queue();
    const s = scheduler();
    s.requestTick();
    await s.idle();
    expect(launched).toHaveLength(0);
    s.start();
    s.requestTick();
    await s.idle();
    expect(launched).toHaveLength(1);
    s.stop();
  });

  it('drops a requested tick when it is stopped before the tick runs', async () => {
    queue();
    const s = scheduler();
    s.start();
    s.requestTick();
    s.stop();
    await s.idle();
    expect(launched).toHaveLength(0);
  });

  it('leaves a queued workstream alone while its previous runner is still finishing', async () => {
    const a = queue();
    running.add(a.workstream.id);
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstreamRow(store.db, a.workstream.id)).toMatchObject({
      state: 'QUEUED',
      leaseOwner: null,
    });
    running.clear();
    expect(await scheduler().tick()).toBe(1);
  });

  it('leases with a fresh fence and renews the lease on the heartbeat', async () => {
    const a = queue();
    const s = scheduler();
    await s.tick();
    expect(launched[0]?.fence).toBe(1);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
    const before = getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt;
    s.start();
    clock.advance(20_000);
    s.stop();
    await s.idle();
    expect(getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt).not.toBe(before);
  });
});

// Workbench spec §5.2, §5.3 (W9), §5.5, §12: a pass's task runs a turn when its rows say so (a builder
// message no turn took, a turn not ended), never from its next action alone, and while a pass holds
// Your folder ordinary work waits for it there.
describe('Workbench passes', () => {
  const PAGES = [
    { name: 'settings', globs: ['src/settings/**'], role: 'page' as const, route: '/settings' },
    { name: 'api', globs: ['api/**'] },
  ];

  /** A pass holding the folder, with one task on the settings page, claimed as the pass claims it. */
  function openPass(project: ReturnType<typeof seedProject>) {
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Settings: UI work',
        acceptanceCriteria: ['x'],
        areas: ['settings'],
      }),
    );
    return state.write((ctx) => {
      const { pass, batch } = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [task.id],
        dirt: [],
      });
      const ws = insertWorkstream(ctx, task.id, {
        batchId: batch.id,
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      const claimed = acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: ws.id,
        requests: [{ kind: 'area', name: 'settings' }],
        leaseExpiresAt: clock.now().toISOString(),
      });
      if (!claimed.ok) throw new Error('the page was not claimed');
      return { pass, batch, task, workstream: ws };
    });
  }

  it('never launches an open pass task, and its page claim holds across a restart with no session', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, opened.workstream.id).state).toBe('QUEUED');

    await recoverOnStartup({
      state,
      inbox,
      git: createGit(),
      processes: systemProcesses,
      jobs: createDeliveryJobs(silentLogger),
      clock: clock,
      maxRecoveryAttempts: 3,
      logger: silentLogger,
      cleanShutdown: false,
    });
    const s = scheduler();
    s.start();
    clock.advance(20_000);
    s.stop();
    await s.idle();
    expect(launched).toEqual([]);
    expect(getWorkstream(store.db, opened.workstream.id)).toMatchObject({
      state: 'QUEUED',
      currentSessionId: null,
    });
    const [claim] = activeClaims(store.db, opened.workstream.id);
    expect(claim?.name).toBe('settings');
    // The heartbeat renews it, as it renews every live workstream's claims.
    expect(claim?.leaseExpiresAt).not.toBe(clock.now().toISOString());
    expect(Date.parse(claim?.leaseExpiresAt ?? '')).toBeGreaterThan(clock.now().getTime());
  });

  /** The builder writes to the page's task. */
  function write(task: { id: Parameters<typeof insertBuilderMessage>[1] }) {
    return state.write((ctx) => insertBuilderMessage(ctx, task.id, { body: 'Tidy it', files: [] }));
  }

  /** Your folder on the pass's branch, as the tick reads it. */
  function onPassBranch(
    opened: ReturnType<typeof openPass>,
    project: ReturnType<typeof seedProject>,
  ) {
    branchOf.set(project.repoPath, opened.batch.branch);
  }

  it('runs a page once the builder writes to it, and never before', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    onPassBranch(opened, project);
    expect(await scheduler().tick()).toBe(0);
    write(opened.task);
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([opened.workstream.id]);
    expect(countLanes(store.db).byPass.get(opened.pass.id)).toBe(1);
  });

  it('runs a turn a crash cut short again after each restart, though its message was taken', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    onPassBranch(opened, project);
    const message = write(opened.task);
    for (const restart of [1, 2]) {
      launched = [];
      expect(await scheduler().tick()).toBe(1);
      const [lane] = launched;
      if (!lane) throw new Error('the page was not launched');
      state.write((ctx) => {
        transitionWorkstream(ctx, opened.workstream.id, { to: 'RUNNING', fence: lane.fence });
        if (restart === 1) {
          insertPassTurn(ctx, {
            taskId: opened.task.id,
            workstreamId: opened.workstream.id,
            sessionId: null,
            messageId: message.id,
          });
          markTaskMessagesDelivered(ctx, opened.task.id, [message.id]);
        }
      });
      await recoverOnStartup({
        state,
        inbox,
        git: createGit(),
        processes: systemProcesses,
        jobs: createDeliveryJobs(silentLogger),
        clock: clock,
        maxRecoveryAttempts: 3,
        logger: silentLogger,
        cleanShutdown: false,
      });
      expect(getWorkstreamRow(store.db, opened.workstream.id)).toMatchObject({
        state: 'QUEUED',
        nextAction: { kind: 'start' },
      });
    }
    launched = [];
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([opened.workstream.id]);
  });

  it('holds a page the builder stopped until the builder writes to it again, then runs it', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    onPassBranch(opened, project);
    const before = write(opened.task);
    // The builder stopped the turn before it took the message.
    state.write((ctx) => {
      const turn = insertPassTurn(ctx, {
        taskId: opened.task.id,
        workstreamId: opened.workstream.id,
        sessionId: null,
        messageId: before.id,
      });
      endPassTurn(ctx, turn.id, { ending: 'stopped', replyBody: null });
      settlePassTurn(ctx, turn.id);
    });
    expect(await scheduler().tick()).toBe(0);

    clock.advance(1_000);
    write(opened.task);
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([opened.workstream.id]);
  });

  it.each([
    {
      name: 'a page being taken out',
      hold: (opened: ReturnType<typeof openPass>) => {
        state.write((ctx) => {
          insertTakeOut(ctx, { taskId: opened.task.id, passId: opened.pass.id, drops: [] });
          advanceTakeOut(ctx, { taskId: opened.task.id, passId: opened.pass.id }, { step: 3 });
        });
      },
    },
    {
      name: 'a page taken out of its pass, its run cancelled',
      hold: (opened: ReturnType<typeof openPass>) => {
        state.write((ctx) => {
          transitionWorkstream(ctx, opened.workstream.id, { to: 'CANCELLED', fence: null });
          releaseClaims(ctx, opened.workstream.id);
          leavePass(ctx, opened.task.id);
        });
      },
    },
    {
      name: 'a page whose folder was switched to another branch',
      hold: (_opened: ReturnType<typeof openPass>, project: ReturnType<typeof seedProject>) => {
        branchOf.set(project.repoPath, 'main');
      },
    },
    {
      name: 'a page of a pass being abandoned',
      hold: () => {
        store.db.update(schema.passes).set({ state: 'ABANDONING' }).run();
      },
    },
  ])('never runs $name, whatever the builder writes', async ({ hold }) => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    onPassBranch(opened, project);
    hold(opened, project);
    write(opened.task);
    expect(await scheduler().tick()).toBe(0);
    expect(launched).toEqual([]);
    // The pass's own card says where the folder is; the batch's wrong-branch card is not raised.
    expect(wrongBranch).toEqual([]);
  });

  it('runs a page that waited at the open only once it holds its page', async () => {
    const project = seedProject(store, { areas: PAGES });
    // Another task held the settings page when the pass opened.
    const holder = add(project, ['settings']);
    state.write((ctx) =>
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: holder.workstream.id,
        requests: [{ kind: 'area', name: 'settings' }],
        leaseExpiresAt: clock.now().toISOString(),
      }),
    );
    moveWorkstream(holder.workstream.id, 'STARTING');
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Settings: UI work',
        acceptanceCriteria: ['x'],
        areas: ['settings'],
      }),
    );
    const { batch, ws } = state.write((ctx) => {
      const opened = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [task.id],
        dirt: [],
      });
      return {
        batch: opened.batch,
        ws: insertWorkstream(ctx, task.id, {
          batchId: opened.batch.id,
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        }),
      };
    });
    branchOf.set(project.repoPath, batch.branch);
    write(task);
    expect(await scheduler().tick()).toBe(0);
    expect(activeClaims(store.db, ws.id)).toEqual([]);
    moveWorkstream(holder.workstream.id, 'CANCELLED');
    state.write((ctx) => releaseClaims(ctx, holder.workstream.id));
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([ws.id]);
    expect(activeClaims(store.db, ws.id).map((c) => c.name)).toEqual(['settings']);
  });

  /** A pass of `pageCap` holding one page whose session is warm, Ready, and one queued page. */
  function warmAndWaiting(pageCap: number, warm = true) {
    const project = seedProject(store, {
      areas: [
        { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
        { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
      ],
    });
    const task = (title: string, area: string) =>
      state.write((ctx) =>
        insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: [area] }),
      );
    const ready = task('Settings: UI work', 'settings');
    const waiting = task('People: UI work', 'people');
    const opened = state.write((ctx) => {
      const { pass, batch } = insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [ready.id, waiting.id],
        dirt: [],
      });
      const first = { model: 'claude-sonnet-5-5', effort: 'medium' } as const;
      const warmWs = insertWorkstream(ctx, ready.id, { batchId: batch.id, first });
      const queued = insertWorkstream(ctx, waiting.id, { batchId: batch.id, first });
      for (const to of ['STARTING', 'RUNNING', 'WAITING_HUMAN'] as const)
        transitionWorkstream(ctx, warmWs.id, { to, fence: null });
      const turn = insertPassTurn(ctx, {
        taskId: ready.id,
        workstreamId: warmWs.id,
        sessionId: null,
        messageId: null,
      });
      endPassTurn(ctx, turn.id, { ending: 'ready', replyBody: null });
      settlePassTurn(ctx, turn.id);
      const session = insertSession(ctx, {
        workstreamId: warmWs.id,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'h',
        briefed: false,
        briefingBaselinePct: null,
      });
      patchWorkstream(ctx, warmWs.id, null, {
        currentSessionId: warm ? session.id : null,
        nextAction: { kind: 'pass_review', inboxId: mintId('InboxItem') },
      });
      insertBuilderMessage(ctx, waiting.id, { body: 'Tidy it', files: [] });
      return { pass, batch, warm: warmWs, queued };
    });
    if (warm) running.add(opened.warm.id);
    branchOf.set(project.repoPath, opened.batch.branch);
    return { ...opened, project };
  }

  it("closes the pass's longest-idle warm session for a page with no room, and launches it once freed", async () => {
    const opened = warmAndWaiting(1);
    expect(await scheduler().tick()).toBe(0);
    expect(closed).toEqual([opened.warm.id]);
    // The runner closed it: the lane is free on the next tick.
    running.delete(opened.warm.id);
    state.write((ctx) => {
      patchWorkstream(ctx, opened.warm.id, null, { currentSessionId: null });
    });
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([opened.queued.id]);
  });

  it.each([
    {
      name: 'ordinary work in Your folder, which waits for the pass',
      waiting: (project: ReturnType<typeof seedProject>) => {
        add(project, ['people']);
        return 1;
      },
    },
    {
      name: 'ordinary work of a project at its own lane limit',
      waiting: () => {
        const busy = queue({ maxLanes: 1 });
        moveWorkstream(busy.workstream.id, 'STARTING');
        add(busy.project, ['api']);
        return 2;
      },
    },
  ])('closes no warm session at the daemon-wide cap for $name', async ({ waiting }) => {
    const opened = warmAndWaiting(4);
    moveWorkstream(opened.queued.id, 'CANCELLED');
    const cap = waiting(opened.project);
    expect(await scheduler({ global: cap }).tick()).toBe(0);
    expect(closed).toEqual([]);
  });

  it('says a page waits for a free session when no warm one can close, and drops it once it starts', async () => {
    const opened = warmAndWaiting(1);
    // The warm page is working again, so no session is idle.
    running.delete(opened.warm.id);
    expect(await scheduler({ global: 1 }).tick()).toBe(0);
    expect(closed).toEqual([]);
    expect(getWorkstream(store.db, opened.queued.id).notice?.line).toBe(
      'Waiting for a free session: 1 is working',
    );
    // Its session ends: the lane is free, and the page starts with no notice left.
    state.write((ctx) => {
      patchWorkstream(ctx, opened.warm.id, null, { currentSessionId: null });
    });
    expect(await scheduler({ global: 1 }).tick()).toBe(1);
    expect(getWorkstream(store.db, opened.queued.id).notice).toBeNull();
  });

  it('holds ordinary work in Your folder while a pass holds it, saying so, and launches it once the pass settles', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    const ordinary = add(project, ['api']);
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, ordinary.workstream.id).notice?.line).toBe(
      'Waits for the Workbench pass to close',
    );
    // A closed pass still holds the folder until its work is in the base. The test has one pass,
    // whose close took its task out.
    moveWorkstream(opened.workstream.id, 'CANCELLED');
    store.db.update(schema.passes).set({ state: 'CLOSED' }).run();
    expect(await scheduler().tick()).toBe(0);
    // Closed, the wait is for the pass's pull request now (D22).
    expect(getWorkstream(store.db, ordinary.workstream.id).notice?.line).toBe(
      "Waits for the Workbench pass's pull request to merge",
    );
    store.db.update(schema.passes).set({ state: 'SETTLED' }).run();
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([ordinary.workstream.id]);
    expect(getWorkstream(store.db, ordinary.workstream.id).notice).toBeNull();
  });

  it('writes its wait over no other notice, and takes it down once the run no longer waits for the pass', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    const kept = add(project, ['api']);
    const reverted = {
      key: REVERTED_NOTICE_KEY,
      tone: 'info' as const,
      line: 'Its commits are reverted on the branch',
      body: 'b',
    };
    state.write((ctx) => setWorkstreamNotice(ctx, kept.workstream.id, reverted));
    const blocker = add(project, ['api']);
    const behind = add(project, ['api'], [blocker.task.id]);
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, kept.workstream.id).notice?.line).toBe(reverted.line);
    expect(getWorkstream(store.db, behind.workstream.id).notice?.key).toBe('workbench-pass');
    // The pass ends; the run still waits, for its dependency now, and says nothing of the pass.
    moveWorkstream(opened.workstream.id, 'CANCELLED');
    moveWorkstream(blocker.workstream.id, 'CANCELLED');
    moveWorkstream(kept.workstream.id, 'CANCELLED');
    store.db.update(schema.passes).set({ state: 'ABANDONED' }).run();
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, behind.workstream.id).notice).toBeNull();
  });

  it('launches the new run of a task its abandoned pass no longer holds', async () => {
    const project = seedProject(store, { areas: PAGES });
    const opened = openPass(project);
    // As the pass's Abandon takes its task out: the run cancelled, its page released.
    moveWorkstream(opened.workstream.id, 'CANCELLED');
    state.write((ctx) => releaseClaims(ctx, opened.workstream.id));
    store.db.update(schema.passes).set({ state: 'ABANDONED' }).run();
    store.db.update(schema.batches).set({ state: 'ABANDONED' }).run();
    const again = state.write((ctx) =>
      insertWorkstream(ctx, opened.task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([again.id]);
  });

  it("leaves a pass's lanes out of its project's lane limit", async () => {
    const project = seedProject(store, { delivery: 'pull_request', areas: PAGES, maxLanes: 1 });
    const opened = openPass(project);
    moveWorkstream(opened.workstream.id, 'STARTING');
    // Ordinary work in a separate copy, where a pass does not hold it.
    const dir = tempDir('worktree');
    try {
      const task = state.write((ctx) =>
        insertTask(ctx, project.id, { title: 'o', acceptanceCriteria: ['x'], areas: ['api'] }),
      );
      const batch = state.write((ctx) => {
        const b = insertBatch(ctx, {
          projectId: project.id,
          title: 'Ordinary',
          baseBranch: 'main',
          worktreePath: dir.path,
        });
        transitionBatch(ctx, b.id, { to: 'OPEN' });
        patchBatch(ctx, b.id, { branch: '10db/ordinary-0a1b2c3d', baseSha: 'a'.repeat(40) });
        return b;
      });
      branchOf.set(dir.path, '10db/ordinary-0a1b2c3d');
      const ordinary = state.write((ctx) =>
        insertWorkstream(ctx, task.id, {
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          batchId: batch.id,
        }),
      );
      expect(await scheduler().tick()).toBe(1);
      expect(launched.map((l) => l.id)).toEqual([ordinary.id]);
    } finally {
      dir.cleanup();
    }
  });
});

describe('pull-request delivery', () => {
  const BRANCH = '10db/greetings-0a1b2c3d';
  /** A pull-request project whose one task is queued in a batch moved through `to` from CUTTING. */
  function inBatch(to: readonly BatchState[], baseSha: string | null = 'a'.repeat(40)) {
    const project = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, { title: 't', acceptanceCriteria: ['x'], areas: ['api'] }),
    );
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, { projectId: project.id, title: 'Greetings', baseBranch: 'main' });
      for (const next of to) transitionBatch(ctx, b.id, { to: next });
      if (to.length > 0) patchBatch(ctx, b.id, { branch: BRANCH, ...(baseSha ? { baseSha } : {}) });
      return b;
    });
    const workstream = state.write((ctx) =>
      insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        batchId: batch.id,
      }),
    );
    return { project, batch, workstream };
  }

  it.each<{
    name: string;
    to: BatchState[];
    baseSha?: string | null;
    current: string | null;
    launched: boolean;
    warned: boolean;
  }>([
    {
      name: 'an open batch on its branch',
      to: ['OPEN'],
      current: BRANCH,
      launched: true,
      warned: false,
    },
    {
      name: 'an open batch on another branch',
      to: ['OPEN'],
      current: 'main',
      launched: false,
      warned: true,
    },
    {
      name: 'an open batch with no base',
      to: ['OPEN'],
      baseSha: null,
      current: BRANCH,
      launched: false,
      warned: false,
    },
    { name: 'a cutting batch', to: [], current: BRANCH, launched: false, warned: false },
    {
      name: 'a failed batch',
      to: ['OPEN', 'FAILED'],
      current: BRANCH,
      launched: false,
      warned: false,
    },
  ])('$name: launched $launched', async ({ to, baseSha, current, launched: expected, warned }) => {
    const q = inBatch(to, baseSha === undefined ? 'a'.repeat(40) : baseSha);
    branchOf.set(q.project.repoPath, current);
    await scheduler().tick();
    expect(launched.map((l) => l.id)).toEqual(expected ? [q.workstream.id] : []);
    expect(wrongBranch).toEqual(warned ? [{ batchId: q.batch.id, current }] : []);
  });

  it('reports a wrong branch once while the batch stays open, and again after it left OPEN and reopened', async () => {
    const q = inBatch(['OPEN']);
    branchOf.set(q.project.repoPath, 'main');
    const s = scheduler();
    await s.tick();
    await s.tick();
    expect(wrongBranch).toHaveLength(1);
    state.write((ctx) => transitionBatch(ctx, q.batch.id, { to: 'FAILED' }));
    await s.tick();
    state.write((ctx) => transitionBatch(ctx, q.batch.id, { to: 'OPEN' }));
    await s.tick();
    expect(wrongBranch).toEqual([
      { batchId: q.batch.id, current: 'main' },
      { batchId: q.batch.id, current: 'main' },
    ]);
  });

  it('waits without a wrong-branch card while git refuses the checkout', async () => {
    const q = inBatch(['OPEN']);
    refusedRepos.add(q.project.repoPath);
    await scheduler().tick();
    expect(launched).toEqual([]);
    expect(wrongBranch).toEqual([]);
  });

  it('waits without a wrong-branch card for a batch in its own worktree', async () => {
    const q = inBatch(['OPEN']);
    state.write((ctx) => patchBatch(ctx, q.batch.id, { worktreePath: '/worktrees/greetings' }));
    branchOf.set(q.project.repoPath, 'main');
    await scheduler().tick();
    expect(launched).toEqual([]);
    expect(wrongBranch).toEqual([]);
  });

  it('never launches pull-request work that has no batch', async () => {
    const project = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    add(project, ['api']);
    expect(await scheduler().tick()).toBe(0);
  });

  it("reads each pull-request project's branch once per tick, and never a local project's", async () => {
    const q = inBatch(['OPEN']);
    add(q.project, ['ui']);
    queue();
    branchOf.set(q.project.repoPath, BRANCH);
    await scheduler().tick();
    expect(branchReads).toEqual([q.project.repoPath]);
  });

  it('runs one tick at a time', async () => {
    const q = inBatch(['OPEN']);
    branchOf.set(q.project.repoPath, BRANCH);
    const s = scheduler();
    const [first, second] = await Promise.all([s.tick(), s.tick()]);
    expect([first, second]).toEqual([1, 0]);
  });

  describe('stopped while a tick reads the branches', () => {
    /** A tick that is inside `branchSnapshot`, held there until `open` is called. */
    async function tickInTheBranchRead() {
      const q = inBatch(['OPEN']);
      branchOf.set(q.project.repoPath, BRANCH);
      let open: () => void = () => undefined;
      branchGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const s = scheduler();
      s.start();
      s.requestTick();
      await waitFor(() => branchReads.length > 0);
      return { s, q, open };
    }

    it('launches nothing once stop() was called, however late the read answers', async () => {
      const { s, open } = await tickInTheBranchRead();
      s.stop();
      open();
      await s.idle();
      expect(launched).toEqual([]);
    });

    it('launches again after start(), as before', async () => {
      const { s, q, open } = await tickInTheBranchRead();
      s.stop();
      open();
      await s.idle();
      s.start();
      s.requestTick();
      await s.idle();
      expect(launched.map((l) => l.id)).toEqual([q.workstream.id]);
      s.stop();
    });

    it('starts no lane between the self-update’s last check and the quit', async () => {
      const { s, open } = await tickInTheBranchRead();
      const applied: string[] = [];
      let held = false;
      const update = createSelfUpdate({
        state,
        inbox,
        clock,
        logger: silentLogger,
        runningCommit: 'a'.repeat(40),
        intervalMs: 60_000,
        repository: 'o/10db',
        enabled: () => true,
        cardProject: () => null,
        headOf: () => Promise.resolve('b'.repeat(40)),
        isAhead: () => Promise.resolve(true),
        stage: () =>
          Promise.resolve({ ok: true, current: false, dir: '/stage', commit: 'b'.repeat(40) }),
        stopStage: () => Promise.resolve(),
        cancelStage: () => Promise.resolve(),
        rollback: { read: () => null, clear: () => undefined },
        apply: (build) => {
          applied.push(build.commit);
          return Promise.resolve({ ok: true, ended: new Promise<void>(() => undefined) });
        },
        // The daemon's own wiring: the real count of lanes, and the real scheduler.
        midSession: () => countMidSession(store.db),
        shapeTurns: () => [],
        waitLimitMs: () => 15 * 60_000,
        drain: { begin: () => undefined, end: () => undefined },
        pause: async () => {
          held = true;
          s.stop();
          await s.idle();
        },
        resume: () => {
          s.start();
          s.requestTick();
        },
        outcome: { read: () => null, clear: () => undefined },
      });
      const check = update.tick();
      // The scheduler's tick is in the branch read when the update holds new work back.
      await waitFor(() => held);
      open();
      expect(await check).toBe('applying');
      expect(applied).toEqual(['b'.repeat(40)]);
      expect(launched).toEqual([]);
      expect(countMidSession(store.db)).toBe(0);
    });
  });
});

describe('accounts', () => {
  const metered = (
    label: string,
    overrides: Partial<{ laneCap: number; monthlyCapUsd: number }> = {},
  ) => {
    const account = seedAccount(store, { kind: 'anthropic_api_key', label, ...overrides });
    state.write((ctx) => recordAccountSecret(ctx, account.id, 'sha256:0000000000000000'));
    return account;
  };

  it('leaves work on an unready account queued and asks the preparer once a tick', async () => {
    const sub = seedAccount(store, { kind: 'claude_subscription', label: 'Company A' });
    const waiting = queue({ accountId: sub.id });
    add(waiting.project, ['ui']);
    const keyed = seedAccount(store, { kind: 'anthropic_api_key', label: 'No secret yet' });
    queue({ accountId: keyed.id });
    expect(await scheduler().tick()).toBe(0);
    expect(prepared.map((p) => p.accountId)).toEqual([sub.id, keyed.id]);
    expect(getWorkstream(state.db, waiting.workstream.id).state).toBe('QUEUED');
  });

  it('asks for the model list once a tick for a ready account a session can start on, not for an unready one', async () => {
    const key = metered('Shared', { laneCap: 2 });
    const a = queue({ accountId: key.id, maxLanes: 3 });
    add(a.project, ['ui']);
    const b = queue({ accountId: key.id, maxLanes: 3 });
    add(b.project, ['ui']);
    const unready = seedAccount(store, { kind: 'anthropic_api_key', label: 'No secret yet' });
    queue({ accountId: unready.id });
    await scheduler().tick();
    expect(listed).toEqual([key.id]);
  });

  it('caps lanes per account across two projects', async () => {
    const key = metered('Shared', { laneCap: 2 });
    const a = queue({ accountId: key.id, maxLanes: 3 });
    add(a.project, ['ui']);
    const b = queue({ accountId: key.id, maxLanes: 3 });
    add(b.project, ['ui']);
    expect(await scheduler().tick()).toBe(2);
    expect(countLanes(state.db).byAccount.get(key.id)).toBe(2);
  });

  it("holds only the paused account's projects", async () => {
    const key = metered('Client key');
    const held = queue({ accountId: key.id });
    const free = queue();
    accounts.rateLimited(key.id, null, held.project.id);
    expect(await scheduler().tick()).toBe(1);
    expect(launched.map((l) => l.id)).toEqual([free.workstream.id]);
  });

  it('raises the usage-limit card once per pause for a project whose work queued during it', async () => {
    const key = metered('Client key');
    const idle = seedProject(store, { name: 'idle', accountId: key.id });
    // The limit hits while the project has no work: the pause raises no card for it.
    accounts.rateLimited(key.id, null, idle.id);
    const limitCards = () =>
      listInbox(state.db, { states: ['OPEN'] }).filter(
        (c) => c.projectId === idle.id && c.title === 'Client key usage limit reached',
      );
    expect(limitCards()).toEqual([]);

    add(idle, ['api']);
    await scheduler().tick();
    expect(limitCards()).toHaveLength(1);
    expect(limitCards()[0]?.options.map((o) => o.label)).toEqual([
      'Continue on Claude plan · builder@example.com',
      'Later',
    ]);
    await scheduler().tick();
    expect(limitCards()).toHaveLength(1);

    const [card] = limitCards();
    if (!card) throw new Error('no usage-limit card');
    inbox.answer(card.id, { choice: 'Later' });
    await scheduler().tick();
    expect(limitCards()).toEqual([]);

    // The next pause is a new one: the waiting work raises the card again.
    pauses.resume(key.id);
    pauses.pause(
      key.id,
      { reason: 'usage_limit', until: new Date(clock.now().getTime() + 60_000) },
      { projectId: idle.id, card: null },
    );
    await scheduler().tick();
    expect(limitCards()).toHaveLength(1);
  });

  it('launches nothing on a metered account at its monthly cap, and launches under it', async () => {
    const key = metered('Capped', { monthlyCapUsd: 5 });
    const capped = queue({ accountId: key.id });
    seedSpend(store, capped.project, 5);
    expect(await scheduler().tick()).toBe(0);
    expect(accounts.isPaused(key.id)).toBe(true);
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.title)).toEqual([
      'Capped reached its monthly cap',
    ]);
    const second = add(seedProject(store, { accountId: key.id }), ['api']);
    expect(await scheduler().tick()).toBe(0);
    expect(
      listInbox(state.db, { states: ['OPEN'] })
        .map((i) => i.projectId)
        .sort(),
    ).toEqual([capped.project.id, second.project.id].sort());
    const roomy = metered('Roomy', { monthlyCapUsd: 5 });
    const under = queue({ accountId: roomy.id });
    seedSpend(store, under.project, 4.99);
    expect(await scheduler().tick()).toBe(1);
  });
});

describe('worktree batches', () => {
  const BRANCH = '10db/greetings-0a1b2c3d';
  let dirs: TempDir[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const dir of dirs) dir.cleanup();
  });

  /** One OPEN worktree batch per entry, each with one QUEUED workstream claiming `claim`. */
  function worktrees(claims: string[], opts: { cutting?: boolean; noBase?: boolean } = {}) {
    const project = seedProject(store, {
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      maxLanes: 3,
      hazards: [
        { name: 'docker', globs: ['docker/**'], commands: [] },
        { name: 'harness', globs: ['AGENTS.md'], commands: [], scope: 'copy' },
      ],
    });
    return claims.map((claim, i) => {
      const dir = tempDir('worktree');
      dirs.push(dir);
      const task = state.write((ctx) =>
        insertTask(ctx, project.id, {
          title: `t${String(i)}`,
          acceptanceCriteria: ['x'],
          areas: [claim],
        }),
      );
      const batch = state.write((ctx) => {
        const b = insertBatch(ctx, {
          projectId: project.id,
          title: `Batch ${String(i)}`,
          baseBranch: 'main',
          worktreePath: dir.path,
        });
        if (opts.cutting) return b;
        transitionBatch(ctx, b.id, { to: 'OPEN' });
        patchBatch(ctx, b.id, {
          branch: `${BRANCH}-${String(i)}`,
          ...(opts.noBase ? {} : { baseSha: 'a'.repeat(40) }),
        });
        return b;
      });
      branchOf.set(dir.path, `${BRANCH}-${String(i)}`);
      const workstream = state.write((ctx) =>
        insertWorkstream(ctx, task.id, {
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          batchId: batch.id,
        }),
      );
      return { project, batch, workstream, path: dir.path };
    });
  }
  function worktree(claim: string, opts: { cutting?: boolean; noBase?: boolean } = {}) {
    const [only] = worktrees([claim], opts);
    if (!only) throw new Error('no worktree batch');
    return only;
  }
  const activeClaims = (name: string) =>
    store.db
      .select()
      .from(schema.claims)
      .all()
      .filter((c) => c.name === name && c.releasedAt === null);

  it("launches three batches' work in one tick with the same area claimed", async () => {
    worktrees(['ui', 'ui', 'ui']);
    expect(await scheduler({ global: 4 }).tick()).toBe(3);
    const held = activeClaims('ui');
    expect(held).toHaveLength(3);
    expect(new Set(held.map((c) => c.scope)).size).toBe(3);
  });

  it('a hazard still serializes them', async () => {
    worktrees(['docker', 'docker', 'docker']);
    expect(await scheduler({ global: 4 }).tick()).toBe(1);
  });

  it("launches three batches' work in one tick with a per-copy hazard claimed", async () => {
    worktrees(['harness', 'harness', 'harness']);
    expect(await scheduler({ global: 4 }).tick()).toBe(3);
    const held = activeClaims('harness');
    expect(held).toHaveLength(3);
    expect(new Set(held.map((c) => c.scope)).size).toBe(3);
  });

  it('waits with one folded card while a worktree is missing', async () => {
    const q = worktree('ui');
    rmSync(q.path, { recursive: true });
    const s = scheduler();
    await s.tick();
    await s.tick();
    expect(missing).toEqual([{ batchId: q.batch.id, path: q.path }]);
    expect(launched).toEqual([]);
    expect(branchReads).toEqual([]);
  });

  it('reports a missing worktree again after the batch left OPEN and reopened', async () => {
    const q = worktree('ui');
    rmSync(q.path, { recursive: true });
    const s = scheduler();
    await s.tick();
    state.write((ctx) => transitionBatch(ctx, q.batch.id, { to: 'FAILED' }));
    await s.tick();
    state.write((ctx) => transitionBatch(ctx, q.batch.id, { to: 'OPEN' }));
    await s.tick();
    expect(missing).toHaveLength(2);
  });

  it('waits without a card while a worktree is unpinned', async () => {
    const q = worktree('ui');
    refusedRepos.add(q.path);
    await scheduler().tick();
    expect(launched).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongBranch).toEqual([]);
  });

  it('waits on another branch and names the worktree', async () => {
    const q = worktree('ui');
    branchOf.set(q.path, 'main');
    await scheduler().tick();
    expect(launched).toEqual([]);
    expect(wrongBranch).toEqual([{ batchId: q.batch.id, current: 'main' }]);
    expect(wrongBranchAt).toEqual([q.path]);
  });

  it('reads nothing for an open batch with no base', async () => {
    worktree('ui', { noBase: true });
    await scheduler().tick();
    expect(branchReads).toEqual([]);
    expect(launched).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('reads nothing for a cutting batch', async () => {
    worktree('ui', { cutting: true });
    await scheduler().tick();
    expect(branchReads).toEqual([]);
    expect(launched).toEqual([]);
    expect(missing).toEqual([]);
  });
});

describe('shared and separate-copy work in one project', () => {
  const BRANCH = '10db/greetings-0a1b2c3d';
  let dirs: TempDir[];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const dir of dirs) dir.cleanup();
  });

  const seed = () =>
    seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)', maxLanes: 3 });

  /** An OPEN batch, in the project's own checkout or in a copy, with one QUEUED task claiming `area`. */
  function openBatch(project: ReturnType<typeof seed>, where: 'shared' | 'copy') {
    const dir = where === 'copy' ? tempDir('worktree') : null;
    if (dir) dirs.push(dir);
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, {
        projectId: project.id,
        title: where,
        baseBranch: 'main',
        ...(dir ? { worktreePath: dir.path } : {}),
      });
      transitionBatch(ctx, b.id, { to: 'OPEN' });
      patchBatch(ctx, b.id, { branch: BRANCH, baseSha: 'a'.repeat(40) });
      return b;
    });
    branchOf.set(dir?.path ?? project.repoPath, BRANCH);
    return batch;
  }
  function queued(project: ReturnType<typeof seed>, batchId: BatchId, area: string, copy = false) {
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, {
        title: area,
        acceptanceCriteria: ['x'],
        areas: [area],
        workspaceMode: copy ? 'worktree' : 'shared',
      }),
    );
    return state.write((ctx) =>
      insertWorkstream(ctx, task.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
        batchId,
      }),
    );
  }

  it('launches a shared task and a copy task on the same area in one tick', async () => {
    const project = seed();
    const shared = queued(project, openBatch(project, 'shared').id, 'ui');
    const copy = queued(project, openBatch(project, 'copy').id, 'ui', true);
    expect(await scheduler({ global: 4 }).tick()).toBe(2);
    expect(launched.map((l) => l.id).sort()).toEqual([shared.id, copy.id].sort());
  });

  it('launches one of two shared tasks on overlapping areas', async () => {
    const project = seed();
    const batch = openBatch(project, 'shared');
    queued(project, batch.id, 'ui');
    queued(project, batch.id, 'ui');
    expect(await scheduler({ global: 4 }).tick()).toBe(1);
  });

  it('launches two shared tasks on disjoint areas in one tick', async () => {
    const project = seed();
    const batch = openBatch(project, 'shared');
    queued(project, batch.id, 'ui');
    queued(project, batch.id, 'api');
    expect(await scheduler({ global: 4 }).tick()).toBe(2);
  });
});
