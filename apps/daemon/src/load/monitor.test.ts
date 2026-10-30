import { InboxState, WorkstreamState } from '@10db/contracts';
import {
  createTestStore,
  listInbox,
  markSessionStarted,
  insertSession,
  patchWorkstream,
  seedProject,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import type { ProcessRow, ProcessSnapshot } from './culprits';
import type { LoadGuard } from './guard';
import { createLaneTempDirs, createLoadMonitor, type LaneTempDirs } from './monitor';

const CORES = 10;
const MINUTE = 60_000;
const DAEMON_PID = 100;

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let inbox: InboxService;
let clock: ManualClock;
let load: number;
let rows: ProcessRow[];
let files: Record<number, string[]>;
let tempDirs: LaneTempDirs;
let cleared: number;
let monitor: LoadGuard;

const processes: ProcessSnapshot = {
  rows: () => Promise.resolve(rows),
  files: (pids) => Promise.resolve(new Map(pids.map((pid) => [pid, files[pid] ?? []] as const))),
};

beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  base = test.store;
  state = createStateStore(base, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  clock = new ManualClock();
  load = 1;
  rows = [];
  files = {};
  tempDirs = createLaneTempDirs();
  cleared = 0;
  monitor = startMonitor();
});

function startMonitor(): LoadGuard {
  return createLoadMonitor({
    state,
    inbox,
    clock,
    logger: silentLogger,
    daemonPid: DAEMON_PID,
    tempRoot: '/private/tmp',
    tempDirs,
    read: () => ({ load, cores: CORES }),
    processes,
    onCleared: () => {
      cleared += 1;
    },
  });
}

afterEach(() => {
  monitor.stop();
  close();
});

async function sampleFor(ms: number): Promise<void> {
  await monitor.sample();
  for (let waited = 0; waited < ms; waited += 30_000) {
    clock.advance(30_000);
    await monitor.sample();
  }
}

const openCards = () => listInbox(base.db, { states: [InboxState.Open] });

/** A lane STARTING with a live session whose process is `pid`. */
function runningLane(title: string, pid: number) {
  const seeded = seedWorkstream(base, { title });
  state.write((ctx) => {
    transitionWorkstream(ctx, seeded.workstream.id, { to: WorkstreamState.Starting, fence: null });
    const session = insertSession(ctx, {
      workstreamId: seeded.workstream.id,
      accountId: seeded.project.accountId,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `hash-${title}`,
    });
    markSessionStarted(ctx, session.id, 'provider-1', pid, 'Thu Oct 29 22:00:00 2026');
  });
  return seeded;
}

describe('the overload card', () => {
  it('raises no card for a Mac that is fine', async () => {
    await sampleFor(10 * MINUTE);
    expect(openCards()).toEqual([]);
  });

  it('raises one card once overloaded, and keeps it one however long it lasts', async () => {
    runningLane('Fix login', 900);
    load = 20 * CORES;
    await sampleFor(15 * MINUTE);
    const cards = openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('The Mac is overloaded: 10db is holding new lanes and gates');
  });

  it('names a busy process that belongs to a lane by its session', async () => {
    runningLane('Fix login', 900);
    rows = [
      { pid: 900, ppid: DAEMON_PID, pgid: DAEMON_PID, cpu: 1, command: 'claude' },
      { pid: 901, ppid: 900, pgid: DAEMON_PID, cpu: 99, command: 'node spin.js' },
    ];
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()[0]?.body).toContain(
      'pid 901 (node spin.js) at 99% of a core: the lane for task "Fix login"',
    );
  });

  it('names a busy orphan by the temp dir its lane still has', async () => {
    const lane = runningLane('Slow thing', 900);
    tempDirs.set(lane.workstream.id, '/private/tmp/10db-abc123');
    rows = [{ pid: 777, ppid: 1, pgid: 777, cpu: 99, command: 'sh loop.sh' }];
    files = { 777: ['/private/tmp/10db-abc123/loop.sh'] };
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()[0]?.body).toContain('the lane for task "Slow thing"');
  });

  it('names a gate by the process group recorded for it', async () => {
    const lane = runningLane('Gated', 900);
    state.write((ctx) => {
      patchWorkstream(ctx, lane.workstream.id, null, { gatePid: 3000, gatePidStart: 'x' });
    });
    rows = [{ pid: 3005, ppid: 1, pgid: 3000, cpu: 95, command: 'vitest' }];
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()[0]?.body).toContain('the gate for task "Gated"');
  });

  it('says a process that is not 10db’s is not', async () => {
    runningLane('Fix login', 900);
    rows = [{ pid: 5, ppid: 1, pgid: 5, cpu: 99, command: 'ffmpeg -i in.mov' }];
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()[0]?.body).toContain('pid 5 (ffmpeg -i in.mov) at 99% of a core: not 10db’s');
  });

  it('rewords the same card as the busy processes change', async () => {
    seedProject(base);
    load = 20 * CORES;
    rows = [{ pid: 5, ppid: 1, pgid: 5, cpu: 99, command: 'first' }];
    await sampleFor(5 * MINUTE);
    rows = [{ pid: 6, ppid: 1, pgid: 6, cpu: 99, command: 'second' }];
    await sampleFor(MINUTE);
    const cards = openCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.body).toContain('second');
    expect(cards[0]?.body).not.toContain('first');
  });

  it('withdraws the card when the load falls', async () => {
    seedProject(base);
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()).toHaveLength(1);
    load = 1;
    await sampleFor(MINUTE);
    expect(openCards()).toEqual([]);
    expect(cleared).toBe(1);
  });

  it('raises a new card for a later overload', async () => {
    seedProject(base);
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    load = 1;
    await sampleFor(MINUTE);
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(openCards()).toHaveLength(1);
  });

  it('withdraws, when 10db starts again, the card an overload left open before a restart', async () => {
    const first = seedProject(base, { name: 'first' });
    const second = seedProject(base, { name: 'second' });
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    // An older stale card on another project, and an unrelated flag that must stay.
    inbox.flag({
      projectId: second.id,
      workstreamId: null,
      title: 'The Mac is overloaded: 10db is holding new lanes and gates',
      body: 'stale',
      foldKey: 'machine-overloaded',
    });
    inbox.flag({
      projectId: first.id,
      workstreamId: null,
      title: 'Something else',
      body: 'unrelated',
      foldKey: 'something-else',
    });
    expect(openCards()).toHaveLength(3);
    // The daemon restarts mid-overload and the load is normal after.
    monitor.stop();
    load = 1;
    monitor = startMonitor();
    expect(openCards().map((c) => c.title)).toEqual(['Something else']);
    await sampleFor(10 * MINUTE);
    expect(openCards().map((c) => c.title)).toEqual(['Something else']);
  });

  it('raises one card for an overload that is still on after a restart', async () => {
    seedProject(base);
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    monitor.stop();
    monitor = startMonitor();
    expect(openCards()).toEqual([]);
    await sampleFor(5 * MINUTE);
    expect(openCards()).toHaveLength(1);
  });

  it('still holds, with no card, when there is no project to put it on', async () => {
    load = 20 * CORES;
    await sampleFor(5 * MINUTE);
    expect(monitor.overloaded).toBe(true);
    expect(openCards()).toEqual([]);
  });
});
