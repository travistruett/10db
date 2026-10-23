import type { WorkstreamId } from '@10db/contracts';
import {
  createTestStore,
  listBoardColumns,
  moveTask,
  getWorkstream,
  getWorkstreamRow,
  insertTask,
  insertWorkstream,
  releaseClaims,
  seedProject,
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

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  launched = [];
  paused = new Set();
  running = new Set();
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

function moveWorkstream(id: WorkstreamId, to: 'STARTING' | 'FAILED' | 'CANCELLED' | 'QUEUED') {
  state.write((ctx) => transitionWorkstream(ctx, id, { to, fence: null }));
}

describe('scheduler', () => {
  it('respects the global cap', () => {
    queue();
    queue();
    queue();
    expect(scheduler({ global: 2, perProvider: 4 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  it('respects a project lane limit and the provider cap', () => {
    const a = queue({ maxLanes: 1 });
    add(a.project, ['ui']);
    queue();
    expect(scheduler({ global: 4, perProvider: 2 }).tick()).toBe(2);
    expect(
      launched
        .map((l) => getWorkstreamRow(store.db, l.id).projectId)
        .filter((p) => p === a.project.id),
    ).toHaveLength(1);
  });

  it('enforces the provider cap on its own', () => {
    queue();
    queue();
    queue();
    expect(scheduler({ global: 4, perProvider: 2 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  it('re-queues PAUSED_LIMIT work that outlived its provider pause', () => {
    const a = queue();
    const s = scheduler();
    s.tick();
    state.write((ctx) => {
      transitionWorkstream(ctx, a.workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    launched = [];

    paused.add('claude');
    s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');

    paused.clear();
    running.add(a.workstream.id);
    s.tick();
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('PAUSED_LIMIT');

    running.clear();
    s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
  });

  it('leaves queued work of a parked task alone', () => {
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
    expect(scheduler().tick()).toBe(0);
    expect(getWorkstream(store.db, first.id).state).toBe('QUEUED');
  });

  it('waits for dependencies', () => {
    const a = queue();
    add(a.project, ['ui'], [a.task.id]);
    scheduler().tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
  });

  it('serializes workstreams that claim the same area', () => {
    const a = queue();
    const b = add(a.project, ['api']);
    const s = scheduler();
    s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    state.write((ctx) => {
      for (const to of ['RUNNING', 'VERIFYING', 'DONE'] as const)
        transitionWorkstream(ctx, a.workstream.id, { to, fence: null });
      releaseClaims(ctx, a.workstream.id);
    });
    s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id, b.workstream.id]);
  });

  it('skips a paused provider', () => {
    queue();
    paused.add('claude');
    expect(scheduler().tick()).toBe(0);
  });

  it('ignores requestTick until it is started', async () => {
    queue();
    const s = scheduler();
    s.requestTick();
    await Promise.resolve();
    expect(launched).toHaveLength(0);
    s.start();
    s.requestTick();
    await Promise.resolve();
    expect(launched).toHaveLength(1);
    s.stop();
  });

  it('drops a requested tick when it is stopped before the tick runs', async () => {
    queue();
    const s = scheduler();
    s.start();
    s.requestTick();
    s.stop();
    await Promise.resolve();
    expect(launched).toHaveLength(0);
  });

  it('leaves a queued workstream alone while its previous runner is still finishing', () => {
    const a = queue();
    running.add(a.workstream.id);
    expect(scheduler().tick()).toBe(0);
    expect(getWorkstreamRow(store.db, a.workstream.id)).toMatchObject({
      state: 'QUEUED',
      leaseOwner: null,
    });
    running.clear();
    expect(scheduler().tick()).toBe(1);
  });

  it('leases with a fresh fence and renews the lease on the heartbeat', () => {
    const a = queue();
    const s = scheduler();
    s.tick();
    expect(launched[0]?.fence).toBe(1);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
    const before = getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt;
    s.start();
    clock.advance(20_000);
    s.stop();
    expect(getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt).not.toBe(before);
  });
});
