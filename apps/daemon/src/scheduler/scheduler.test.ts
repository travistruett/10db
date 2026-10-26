import type { AccountId, BatchState, ProjectId, WorkstreamId } from '@10db/contracts';
import {
  countLanes,
  createTestStore,
  listBoardColumns,
  listInbox,
  patchAccount,
  recordAccountSecret,
  seedAccount,
  moveTask,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertTask,
  insertWorkstream,
  patchBatch,
  releaseClaims,
  seedProject,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedSpend } from '../../test/fixtures';
import {
  createAccountPauses,
  createAccountRuntime,
  type AccountPauses,
  type AccountRuntime,
} from '../accounts';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { createScheduler } from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let launched: { id: WorkstreamId; fence: number }[];
let inbox: InboxService;
let pauses: AccountPauses;
let accounts: AccountRuntime;
let running: Set<WorkstreamId>;
let branchOf: Map<string, string | null>;
let branchReads: string[];
let prepared: { accountId: AccountId; projectId: ProjectId }[];
let wrongBranch: { batchId: string; current: string | null }[];

beforeEach(() => {
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
  accounts = createAccountRuntime({ state, clock, inbox, pauses, defaultPauseMs: 30 * 60_000 });
  launched = [];
  running = new Set();
  branchOf = new Map();
  branchReads = [];
  wrongBranch = [];
  prepared = [];
});
afterEach(() => {
  close();
});

function scheduler(caps = { global: 4 }) {
  return createScheduler({
    state,
    clock,
    caps,
    instanceId: 'daemon-1',
    leaseMs: 60_000,
    tickMs: 2_000,
    logger: silentLogger,
    runner: {
      launch: (id, fence) => {
        launched.push({ id, fence });
      },
      isRunning: (id) => running.has(id),
    },
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        prepared.push({ accountId: account.id, projectId });
      },
    },
    branches: {
      currentBranch: (repo) => {
        branchReads.push(repo);
        return Promise.resolve(branchOf.get(repo) ?? null);
      },
    },
    onWrongBranch: (batch, current) => {
      wrongBranch.push({ batchId: batch.id, current });
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
  return { project, task, workstream: state.write((ctx) => insertWorkstream(ctx, task.id)) };
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
  it('respects the global cap', async () => {
    queue();
    queue();
    queue();
    expect(await scheduler({ global: 2 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
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
    const second = state.write((ctx) => insertWorkstream(ctx, task.id));
    moveWorkstream(second.id, 'CANCELLED');
    const column = listBoardColumns(store.db, project.id)[0];
    if (!column) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, task.id, { to: column.id, after: null, before: null }));
    // The retry route refuses this; the scheduler holds the line if a queue entry gets here anyway.
    moveWorkstream(first.id, 'QUEUED');
    expect(await scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, first.id).state).toBe('QUEUED');
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
    const workstream = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
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
