import type { BatchState, WorkstreamId } from '@10db/contracts';
import {
  createTestStore,
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
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createScheduler } from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let launched: { id: WorkstreamId; fence: number }[];
let paused: Set<string>;
let running: Set<WorkstreamId>;
let branchOf: Map<string, string | null>;
let branchReads: string[];
let wrongBranch: { batchId: string; current: string | null }[];

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  launched = [];
  paused = new Set();
  running = new Set();
  branchOf = new Map();
  branchReads = [];
  wrongBranch = [];
});
afterEach(() => {
  close();
});

function scheduler(caps = { global: 4, perProvider: 4 }) {
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
    pauses: { isPaused: (p) => paused.has(p) },
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

describe('scheduler', () => {
  it('respects the global cap', async () => {
    queue();
    queue();
    queue();
    expect(await scheduler({ global: 2, perProvider: 4 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  it('respects a project lane limit and the provider cap', async () => {
    const a = queue({ maxLanes: 1 });
    add(a.project, ['ui']);
    queue();
    expect(await scheduler({ global: 4, perProvider: 2 }).tick()).toBe(2);
    expect(
      launched
        .map((l) => getWorkstreamRow(store.db, l.id).projectId)
        .filter((p) => p === a.project.id),
    ).toHaveLength(1);
  });

  it('enforces the provider cap on its own', async () => {
    queue();
    queue();
    queue();
    expect(await scheduler({ global: 4, perProvider: 2 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  it('re-queues PAUSED_LIMIT work that outlived its provider pause', async () => {
    const a = queue();
    const s = scheduler();
    await s.tick();
    state.write((ctx) => {
      transitionWorkstream(ctx, a.workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    launched = [];

    paused.add('claude');
    await s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');

    paused.clear();
    running.add(a.workstream.id);
    await s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');

    running.clear();
    await s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
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

  it('skips a paused provider', async () => {
    queue();
    paused.add('claude');
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
