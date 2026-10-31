import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import {
  createLaneProcessWatch,
  createLedgerSweep,
  createProcessLedger,
  reapLaneProcessLedgers,
  removeProcessLedger,
  type LaneProcessDeps,
  type LaneProcessWatchDeps,
} from './lane-processes';
import type { ProcessRow, ProcessTable } from './process-table';

const DAEMON = 100;
const DAEMON_GROUP = 100;
const T0 = 'Thu Oct 30 12:00:00 2026';
const T1 = 'Thu Oct 30 12:00:05 2026';

/** A machine of fake processes: signals end them unless they ignore SIGTERM, and every row is listed. */
class World {
  rows: ProcessRow[] = [
    { pid: 1, ppid: 0, pgid: 1, startedAt: T0 },
    { pid: DAEMON, ppid: 1, pgid: DAEMON_GROUP, startedAt: T0 },
  ];
  readonly signals: { target: number; sig: string }[] = [];
  readonly ignoresTerm = new Set<number>();
  /** Each process's working directory, as `lsof` would report it. */
  readonly cwd = new Map<number, string>();
  /** The files each process holds open, as `lsof` would report them. */
  readonly files = new Map<number, string[]>();
  pathReads = 0;

  add(pid: number, ppid: number, pgid: number, startedAt = T1): void {
    this.rows.push({ pid, ppid, pgid, startedAt });
  }
  /** What the kernel does when a parent dies: its children go to launchd. */
  die(pid: number): void {
    this.rows = this.rows.filter((r) => r.pid !== pid);
    this.rows = this.rows.map((r) => (r.ppid === pid ? { ...r, ppid: 1 } : r));
  }
  has(pid: number): boolean {
    return this.rows.some((r) => r.pid === pid);
  }
  readonly table: ProcessTable = () => Promise.resolve(this.rows.map((r) => ({ ...r })));
  readonly openPaths = (pids: readonly number[]): Promise<ReadonlyMap<number, string[]>> => {
    this.pathReads += 1;
    const found = new Map<number, string[]>();
    for (const pid of pids) {
      if (!this.has(pid)) continue;
      const dir = this.cwd.get(pid);
      found.set(pid, [...(dir === undefined ? [] : [dir]), ...(this.files.get(pid) ?? [])]);
    }
    return Promise.resolve(found);
  };
  readonly signal = (target: number, sig: NodeJS.Signals): boolean => {
    this.signals.push({ target, sig });
    const hit = this.rows.filter((r) => (target < 0 ? r.pgid === -target : r.pid === target));
    if (hit.length === 0) return false;
    for (const r of hit) {
      if (sig === 'SIGTERM' && this.ignoresTerm.has(r.pid)) continue;
      this.die(r.pid);
    }
    return true;
  };
}

let world: World;
let dir: string;
beforeEach(() => {
  world = new World();
  dir = mkdtempSync(join(tmpdir(), 'lp-'));
});
const children: ChildProcess[] = [];
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** A real process that stays alive until the test ends: a daemon still running. */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  if (child.pid === undefined) throw new Error('no pid');
  return child.pid;
}

/** The pid of a real process that has exited: a daemon that died. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.once('exit', resolve));
  if (pid === undefined) throw new Error('no pid');
  return pid;
}

/** The mark a running daemon keeps in the temp root (`claimSandboxTempRoot`). */
function markDaemon(pid: number): void {
  writeFileSync(join(dir, `10db-daemon-${String(pid)}`), '', { mode: 0o400 });
}

function deps(overrides: Partial<LaneProcessDeps> = {}): LaneProcessDeps {
  return {
    table: world.table,
    signal: world.signal,
    sleep: () => Promise.resolve(),
    ownPid: DAEMON,
    graceMs: 100,
    pollMs: 50,
    ...overrides,
  };
}

const ROOT = { pid: 200, startedAt: T1 };

/** A session as the incident had it: claude, a command's shell, and twelve busy loops under it. */
function incident(): number[] {
  world.add(200, DAEMON, 200); // claude
  world.add(300, 200, 300); // the command's shell, a group leader of its own
  const loops = Array.from({ length: 12 }, (_, i) => 400 + i);
  for (const pid of loops) world.add(pid, 300, 300);
  return loops;
}

describe('a lane process watch', () => {
  it('stops everything the session started when it ends, subshells and loops included', async () => {
    const loops = incident();
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    await watch.end();
    for (const pid of [200, 300, ...loops]) expect(world.has(pid)).toBe(false);
    expect(world.has(DAEMON)).toBe(true);
    expect(world.has(1)).toBe(true);
  });

  it('still stops loops whose parents died before the session ended, because it saw them while they ran', async () => {
    const loops = incident();
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    // The daemon restarts: claude and the command's shell die, and the loops go to launchd.
    world.die(200);
    world.die(300);
    expect(world.rows.filter((r) => loops.includes(r.pid)).every((r) => r.ppid === 1)).toBe(true);
    await watch.end();
    for (const pid of loops) expect(world.has(pid)).toBe(false);
  });

  it('follows what the loops start later, and what escaped to launchd inside a known group', async () => {
    incident();
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    world.add(500, 400, 300); // forked from a loop after the last sample
    world.add(501, 1, 300); // double-forked: launchd is its parent, the group is the command's
    await watch.end();
    expect(world.has(500)).toBe(false);
    expect(world.has(501)).toBe(false);
  });

  it('samples again on its interval, so a loop started after tracking began is known', async () => {
    world.add(200, DAEMON, 200);
    const ticks: (() => void)[] = [];
    const watch = createLaneProcessWatch({
      ...deps(),
      ledger: null,
      timers: {
        setTimeout(fn) {
          ticks.push(fn);
          return { cancel: () => undefined };
        },
      },
    });
    await watch.track(ROOT);
    world.add(300, 200, 300);
    world.add(400, 300, 300);
    ticks.shift()?.();
    await new Promise((r) => setImmediate(r));
    world.die(200);
    world.die(300);
    await watch.end();
    expect(world.has(400)).toBe(false);
  });

  it('never signals the daemon, launchd, or the daemon’s own process group', async () => {
    // claude was started in the daemon's group, as a plain child is.
    world.add(200, DAEMON, DAEMON_GROUP);
    world.add(300, 200, DAEMON_GROUP);
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    await watch.end();
    expect(world.has(DAEMON)).toBe(true);
    expect(world.has(200)).toBe(false);
    expect(world.has(300)).toBe(false);
    expect(world.signals.every((s) => s.target > 1 && s.target !== -DAEMON_GROUP)).toBe(true);
  });

  it('leaves alone a process that took a recorded pid after the old one died', async () => {
    incident();
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    world.die(401);
    world.add(401, 1, 401, 'Thu Oct 30 13:00:00 2026');
    await watch.end();
    expect(world.has(401)).toBe(true);
  });

  it('sends SIGKILL to what ignores SIGTERM', async () => {
    incident();
    world.ignoresTerm.add(405);
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.track(ROOT);
    await watch.end();
    expect(world.has(405)).toBe(false);
    expect(world.signals.some((s) => s.sig === 'SIGKILL')).toBe(true);
  });

  describe('when the session’s start time could not be read as it started', () => {
    /** Timers that only fire when the test says so. */
    function manualTimers(): {
      readonly ticks: (() => void)[];
      readonly timers: NonNullable<LaneProcessWatchDeps['timers']>;
    } {
      const ticks: (() => void)[] = [];
      return {
        ticks,
        timers: {
          setTimeout(fn) {
            ticks.push(fn);
            return { cancel: () => undefined };
          },
        },
      };
    }
    const settle = () => new Promise((r) => setImmediate(r));
    const failingPs = (): Promise<readonly ProcessRow[]> =>
      Promise.reject(new Error('ps: fork failed'));

    it('reads it from its own fresh reading, and still stops everything the session started', async () => {
      const loops = incident();
      const watch = createLaneProcessWatch({ ...deps(), ledger: null });
      expect(await watch.track({ pid: 200, startedAt: null })).toBe(true);
      world.die(200);
      world.die(300);
      await watch.end();
      for (const pid of loops) expect(world.has(pid)).toBe(false);
    });

    it('keeps reading fresh on each sample until one finds the session’s process, and watches it from then on', async () => {
      const loops = incident();
      let failures = 2;
      const table: ProcessTable = () => (failures-- > 0 ? failingPs() : world.table());
      const { ticks, timers } = manualTimers();
      const watch = createLaneProcessWatch({
        ...deps({ table }),
        // A shared reading from before the session's process began: it would never find it.
        sampleTable: () => Promise.resolve(world.rows.filter((r) => r.pid < 200)),
        ledger: null,
        timers,
      });
      expect(await watch.track({ pid: 200, startedAt: null })).toBe(false);
      ticks.shift()?.();
      await settle();
      ticks.shift()?.();
      await settle();
      // The daemon restarts: claude and the command's shell die, and the loops go to launchd.
      world.die(200);
      world.die(300);
      await watch.end();
      for (const pid of loops) expect(world.has(pid)).toBe(false);
    });

    it('rejects at the end when no reading ever found the session’s process, having signalled nothing', async () => {
      incident();
      let readable = false;
      const table: ProcessTable = () => (readable ? world.table() : failingPs());
      const ledger = createProcessLedger(dir);
      const watch = createLaneProcessWatch({
        ...deps({ table }),
        ledger,
        timers: manualTimers().timers,
      });
      expect(await watch.track({ pid: 200, startedAt: null })).toBe(false);
      // By the end the session's process is gone, so a pid listed then is never taken for it.
      readable = true;
      await expect(watch.end()).rejects.toThrow(/never read/);
      expect(world.signals).toEqual([]);
      expect(watch.pending()).toBe(false);
    });
  });

  it('does nothing when nothing was tracked, and twice is the same as once', async () => {
    const watch = createLaneProcessWatch({ ...deps(), ledger: null });
    await watch.end();
    await watch.track(ROOT);
    await watch.end();
    await watch.end();
    expect(world.signals).toEqual([]);
  });

  it('keeps a ledger of what it saw, and empties it once it has stopped everything', async () => {
    incident();
    const ledger = createProcessLedger(dir);
    const watch = createLaneProcessWatch({ ...deps(), ledger });
    await watch.track(ROOT);
    const seen = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
    expect(seen.members.map((m) => m.pid)).toEqual(expect.arrayContaining([200, 300, 400, 411]));
    await watch.end();
    const after = JSON.parse(readFileSync(ledger, 'utf8')) as { members: unknown[] };
    expect(after.members).toEqual([]);
    removeProcessLedger(ledger, dir);
    expect(existsSync(ledger)).toBe(false);
  });

  describe('a job whose command returned at once, so its shell was never sampled', () => {
    /** The checkout, shared with other lanes and the builder in Your folder mode. */
    const CHECKOUT = '/Users/me/Projects/app';
    const LANE_TMP = '/private/tmp/10db-abc123';
    /** Claude Code's file for a command's output, in the lane's CLAUDE_CODE_TMPDIR. */
    const OUTPUT = `${LANE_TMP}/claude-501/-Users-me-Projects-app/s1/tasks/b1.output`;
    const T2 = 'Thu Oct 30 12:00:07 2026';
    function setup(): void {
      world.add(200, DAEMON, DAEMON_GROUP); // claude, in the daemon's group as spawned
      // `pnpm dev &`: the command's shell (300) forked the job and exited within milliseconds,
      // before any sample; the job went to launchd, still writing to the command's output file.
      world.add(600, 1, 300, T2);
      world.cwd.set(600, `${CHECKOUT}/apps/web`);
      world.files.set(600, [OUTPUT]);
      world.add(601, 600, 300, T2); // what the job started
      // `(while :; do :; done) > /dev/null 2>&1 &` from the lane's temp dir.
      world.add(610, 1, 610, T2);
      world.cwd.set(610, LANE_TMP);
      // Not the lane's: a launchd job started meanwhile elsewhere, and one in the checkout from
      // before the session began.
      world.add(700, 1, 700, T2);
      world.cwd.set(700, '/Applications/Other.app');
      world.add(701, 1, 701, T0);
      world.cwd.set(701, CHECKOUT);
      // A temp dir whose name merely starts with this one's.
      world.add(702, 1, 702, T2);
      world.cwd.set(702, `${LANE_TMP}x`);
      world.files.set(702, [`${LANE_TMP}x/out`]);
    }
    const watchDeps = (ledger: string | null = null) => ({
      ...deps(),
      openPaths: world.openPaths,
      places: [LANE_TMP],
      ledger,
    });

    it('stops it when the session ends, by a file it holds open or its working dir in the lane’s temp dir', async () => {
      setup();
      const watch = createLaneProcessWatch(watchDeps());
      await watch.track(ROOT);
      await watch.end();
      for (const pid of [600, 601, 610]) expect(world.has(pid)).toBe(false);
      for (const pid of [DAEMON, 700, 701, 702]) expect(world.has(pid)).toBe(true);
    });

    it('never takes a job for working in the checkout alone: it may be another lane’s or the builder’s', async () => {
      setup();
      const ledger = createProcessLedger(dir);
      const ticks: (() => void)[] = [];
      const watch = createLaneProcessWatch({
        ...watchDeps(ledger),
        timers: {
          setTimeout(fn) {
            ticks.push(fn);
            return { cancel: () => undefined };
          },
        },
      });
      await watch.track(ROOT);
      // Another lane in the same checkout runs `pnpm dev > dev.log 2>&1 &`, and the builder runs
      // `nohup pnpm dev &` from a terminal there, after this session began.
      world.add(800, 1, 800, T2);
      world.cwd.set(800, CHECKOUT);
      world.files.set(800, [`${CHECKOUT}/dev.log`]);
      world.add(801, 800, 800, T2);
      world.add(810, 1, 810, T2);
      world.cwd.set(810, `${CHECKOUT}/apps/web`);
      world.files.set(810, [`${CHECKOUT}/apps/web/nohup.out`]);
      // A sample runs while they do.
      ticks.shift()?.();
      await new Promise((r) => setImmediate(r));
      const seen = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
      expect(seen.members.map((m) => m.pid)).toEqual(expect.arrayContaining([600, 610]));
      expect(seen.members.filter((m) => [800, 801, 810].includes(m.pid))).toEqual([]);
      await watch.end();
      for (const pid of [800, 801, 810]) expect(world.has(pid)).toBe(true);
      expect(world.signals.some((s) => [800, 801, 810, -800, -810].includes(s.target))).toBe(false);
    });

    it('finds one that left between the last sample and the end', async () => {
      world.add(200, DAEMON, DAEMON_GROUP);
      const watch = createLaneProcessWatch(watchDeps());
      await watch.track(ROOT);
      world.add(600, 1, 300, T2);
      world.cwd.set(600, CHECKOUT);
      world.files.set(600, [OUTPUT]);
      await watch.end();
      expect(world.has(600)).toBe(false);
    });

    it('records it in the ledger, so a daemon that dies before the end still has it stopped', async () => {
      setup();
      const ledger = createProcessLedger(dir, await deadPid());
      await createLaneProcessWatch(watchDeps(ledger)).track(ROOT);
      const seen = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
      expect(seen.members.map((m) => m.pid)).toEqual(expect.arrayContaining([600, 601, 610]));
      world.die(200);
      await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
      for (const pid of [600, 601, 610]) expect(world.has(pid)).toBe(false);
      expect(world.has(700)).toBe(true);
    });

    it('reads each new orphan’s open files once, not on every sample', async () => {
      setup();
      const ticks: (() => void)[] = [];
      const watch = createLaneProcessWatch({
        ...watchDeps(),
        timers: {
          setTimeout(fn) {
            ticks.push(fn);
            return { cancel: () => undefined };
          },
        },
      });
      await watch.track(ROOT);
      const after = world.pathReads;
      for (let n = 0; n < 3; n += 1) {
        ticks.shift()?.();
        await new Promise((r) => setImmediate(r));
      }
      expect(world.pathReads).toBe(after);
    });
  });

  it('takes its first sample fresh, not from a shared reading made before the session’s process', async () => {
    const before = world.rows.map((r) => ({ ...r }));
    const loops = incident();
    const watch = createLaneProcessWatch({
      ...deps(),
      // A reading from before claude was spawned, as the shared cache can hand out.
      sampleTable: () => Promise.resolve(before),
      ledger: null,
    });
    await watch.track(ROOT);
    world.die(200);
    world.die(300);
    await watch.end();
    for (const pid of loops) expect(world.has(pid)).toBe(false);
  });

  it('says whether it still holds processes it has not stopped', async () => {
    incident();
    const failing = { fail: false };
    const watch = createLaneProcessWatch({
      ...deps({
        table: () => (failing.fail ? Promise.reject(new Error('ps failed')) : world.table()),
      }),
      ledger: null,
    });
    expect(watch.pending()).toBe(false);
    await watch.track(ROOT);
    expect(watch.pending()).toBe(true);
    failing.fail = true;
    await expect(watch.end()).rejects.toThrow('ps failed');
    expect(watch.pending()).toBe(true);
    failing.fail = false;
    await watch.end();
    expect(watch.pending()).toBe(false);
  });

  it('still remembers the tree when the open paths cannot be read, and stops it at the end', async () => {
    const loops = incident();
    world.add(600, 1, 600); // a child of launchd started since, whose open paths are to be read
    const ledger = createProcessLedger(dir);
    const watch = createLaneProcessWatch({
      ...deps(),
      openPaths: () => Promise.reject(new Error('lsof: fork failed')),
      places: ['/private/tmp/10db-abc123'],
      ledger,
    });
    await watch.track(ROOT);
    const seen = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
    expect(seen.members.map((m) => m.pid)).toEqual(expect.arrayContaining([200, 300, ...loops]));
    // claude and the command's shell die; the loops go to launchd.
    world.die(200);
    world.die(300);
    await watch.end();
    for (const pid of loops) expect(world.has(pid)).toBe(false);
    expect(world.has(600)).toBe(true);
  });

  it('tells what it could not do by kind: write its ledger, read the table, read open paths', async () => {
    incident();
    world.add(600, 1, 600);
    const clock = new ManualClock();
    const failing = { table: false };
    const failures: unknown[] = [];
    const watch = createLaneProcessWatch({
      ...deps({
        table: () => (failing.table ? Promise.reject(new Error('ps failed')) : world.table()),
      }),
      openPaths: () => Promise.reject(new Error('lsof failed')),
      places: ['/private/tmp/10db-abc123'],
      // In a dir that is gone, so no write of it can succeed.
      ledger: join(dir, 'gone', '10db-proc-100-0123456789ab.json'),
      timers: clock,
      intervalMs: 1_000,
      onError: (failure) => failures.push(failure),
    });
    await watch.track(ROOT);
    failing.table = true;
    clock.advance(1_000);
    await new Promise((r) => setImmediate(r));
    expect([...new Set(failures)].sort()).toEqual(['ledger', 'open_paths', 'table']);
  });

  it('replaces its ledger whole on each write, so a reader holding it never sees a part of one', async () => {
    world.add(200, DAEMON, 200);
    const ledger = createProcessLedger(dir);
    const clock = new ManualClock();
    const watch = createLaneProcessWatch({ ...deps(), ledger, timers: clock, intervalMs: 1_000 });
    await watch.track(ROOT);
    const before = readFileSync(ledger, 'utf8');
    const held = openSync(ledger, 'r');
    try {
      world.add(300, 200, 300);
      clock.advance(1_000);
      await new Promise((r) => setImmediate(r));
      // The file a reader opened is still the whole ledger it was; the name holds the next one.
      expect(readFileSync(held, 'utf8')).toBe(before);
      const after = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
      expect(after.members.map((m) => m.pid).sort()).toEqual([200, 300]);
      expect(readdirSync(dir)).toEqual([basename(ledger)]);
    } finally {
      closeSync(held);
    }
  });

  it('survives a table it cannot read: it stops nothing and says so', async () => {
    const watch = createLaneProcessWatch({
      ...deps({ table: () => Promise.reject(new Error('ps failed')) }),
      ledger: null,
    });
    // The session's process is known by its start time, so the table is only needed later.
    await expect(watch.track(ROOT)).resolves.toBe(true);
    await expect(watch.end()).rejects.toThrow('ps failed');
  });
});

describe('processes left by a daemon that died', () => {
  it('stops what a ledger names and removes the ledger, before any new session starts', async () => {
    const loops = incident();
    const ledger = createProcessLedger(dir);
    await createLaneProcessWatch({ ...deps(), ledger }).track(ROOT);
    // The daemon is gone: its sessions' parents die, the loops keep running.
    world.die(200);
    world.die(300);

    const report = await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
    expect(report).toEqual({ ledgers: 1, stopped: loops.length });
    for (const pid of loops) expect(world.has(pid)).toBe(false);
    expect(existsSync(ledger)).toBe(false);
  });

  it('does not read a machine it has no ledger for', async () => {
    let reads = 0;
    const counting = deps({
      table: () => {
        reads += 1;
        return world.table();
      },
    });
    expect(await reapLaneProcessLedgers(dir, counting)).toEqual({ ledgers: 0, stopped: 0 });
    expect(reads).toBe(0);
  });

  it('removes an unreadable ledger, and ignores files that are not ledgers', async () => {
    const owner = String(await deadPid());
    writeFileSync(join(dir, `10db-proc-${owner}-0123456789ab.json`), '{not json');
    writeFileSync(join(dir, `10db-proc-${owner}-notahexid.json`), '{"version":1,"members":[]}');
    writeFileSync(join(dir, '10db-proc-0123456789ab.json'), '{"version":1,"members":[]}');
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const report = await reapLaneProcessLedgers(dir, deps());
    expect(report.ledgers).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(
      ['10db-proc-0123456789ab.json', `10db-proc-${owner}-notahexid.json`, 'unrelated.json'].sort(),
    );
  });

  it('names the daemon that owns each ledger', () => {
    expect(createProcessLedger(dir, 4321)).toMatch(/\/10db-proc-4321-[0-9a-f]{12}\.json$/);
    expect(createProcessLedger(dir)).toContain(`/10db-proc-${String(process.pid)}-`);
  });

  it('stops a dead daemon’s leftovers while another daemon runs on the same root, and leaves the live one’s alone', async () => {
    // The app daemon restarted for an install; a second daemon on another data dir kept running.
    const other = livePid();
    markDaemon(other);
    const dead = await deadPid();
    world.add(400, 1, 400); // the dead daemon's lane's loop
    world.add(500, 1, 500); // the live daemon's lane's dev server, its session still running
    const deadLedger = createProcessLedger(dir, dead);
    writeFileSync(
      deadLedger,
      JSON.stringify({ version: 1, members: [{ pid: 400, pgid: 400, startedAt: T1 }] }),
    );
    const liveLedger = createProcessLedger(dir, other);
    writeFileSync(
      liveLedger,
      JSON.stringify({ version: 1, members: [{ pid: 500, pgid: 500, startedAt: T1 }] }),
    );

    const report = await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
    expect(report).toEqual({ ledgers: 1, stopped: 1 });
    expect(world.has(400)).toBe(false);
    expect(existsSync(deadLedger)).toBe(false);
    expect(world.has(500)).toBe(true);
    expect(existsSync(liveLedger)).toBe(true);
  });

  it('takes a ledger as a dead daemon’s when its owner runs but keeps no mark, or is this daemon', async () => {
    // A dead daemon's pid now names an unrelated process; or the new daemon got the old one's pid.
    const reused = livePid();
    world.add(400, 1, 400);
    world.add(410, 1, 410);
    writeFileSync(
      createProcessLedger(dir, reused),
      JSON.stringify({ version: 1, members: [{ pid: 400, pgid: 400, startedAt: T1 }] }),
    );
    writeFileSync(
      createProcessLedger(dir, 9999),
      JSON.stringify({ version: 1, members: [{ pid: 410, pgid: 410, startedAt: T1 }] }),
    );
    markDaemon(9999);
    const report = await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
    expect(report).toEqual({ ledgers: 2, stopped: 2 });
    expect(world.has(400)).toBe(false);
    expect(world.has(410)).toBe(false);
  });

  it('leaves a process alone when its pid now belongs to another process', async () => {
    const ledger = createProcessLedger(dir);
    writeFileSync(
      ledger,
      JSON.stringify({ version: 1, members: [{ pid: 700, pgid: 700, startedAt: T0 }] }),
    );
    world.add(700, 1, 700, 'Fri Oct 31 09:00:00 2026');
    const report = await reapLaneProcessLedgers(dir, deps());
    expect(report.stopped).toBe(0);
    expect(world.has(700)).toBe(true);
    expect(existsSync(ledger)).toBe(false);
  });

  it('keeps a ledger it could not act on, so the next start tries again', async () => {
    const ledger = createProcessLedger(dir);
    writeFileSync(
      ledger,
      JSON.stringify({ version: 1, members: [{ pid: 700, pgid: 700, startedAt: T0 }] }),
    );
    await expect(
      reapLaneProcessLedgers(dir, deps({ table: () => Promise.reject(new Error('ps failed')) })),
    ).rejects.toThrow('ps failed');
    expect(existsSync(ledger)).toBe(true);
  });

  it('stops what shared the dead daemon’s process group by pid alone, and leaves the rest of that group running', async () => {
    // A dev daemon run from a terminal: pnpm (50) leads the job's group, which holds turbo (51),
    // vite (52), tsx watch (53) and the daemon. Claude Code was spawned into that group, and so was a
    // command's shell and the loop it left; another job of the command leads a group of its own.
    world.rows = [
      { pid: 1, ppid: 0, pgid: 1, startedAt: T0 },
      { pid: 50, ppid: 1, pgid: 50, startedAt: T0 },
      { pid: 51, ppid: 50, pgid: 50, startedAt: T0 },
      { pid: 52, ppid: 51, pgid: 50, startedAt: T0 },
      { pid: 53, ppid: 51, pgid: 50, startedAt: T0 },
      { pid: DAEMON, ppid: 53, pgid: 50, startedAt: T0 },
    ];
    world.add(200, DAEMON, 50); // claude
    world.add(300, 200, 50); // the command's shell
    world.add(400, 300, 50); // its `(while :; do :; done) &`
    world.add(600, 300, 600); // a job in a group of its own
    await createLaneProcessWatch({ ...deps(), ledger: createProcessLedger(dir) }).track(ROOT);
    // The daemon dies with claude still in its turn. tsx watch starts the dev daemon again in the
    // job's group, and the job's group gains a process no sample saw.
    world.die(DAEMON);
    world.add(150, 53, 50);
    world.add(601, 1, 600);
    // The app's daemon, in a group of its own, starts and reaps the ledger.
    world.add(900, 1, 900);
    await reapLaneProcessLedgers(dir, deps({ ownPid: 900 }));
    for (const pid of [200, 300, 400, 600, 601]) expect(world.has(pid)).toBe(false);
    for (const pid of [50, 51, 52, 53, 150, 900]) expect(world.has(pid)).toBe(true);
    expect(world.signals.some((s) => s.target === -50)).toBe(false);
  });

  it('signals no process group for a ledger that does not say which group its daemon was in', async () => {
    world.add(400, 1, 400);
    world.add(401, 1, 400);
    writeFileSync(
      createProcessLedger(dir),
      JSON.stringify({ version: 1, members: [{ pid: 400, pgid: 400, startedAt: T1 }] }),
    );
    await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
    expect(world.has(400)).toBe(false);
    expect(world.signals.every((s) => s.target > 0)).toBe(true);
  });

  it('never reads a ledger’s next content as the ledger, and removes what a dead daemon left of one', async () => {
    world.add(400, 1, 400);
    world.add(500, 1, 500);
    const next = (ledger: string, pid: number): string => {
      // A daemon killed between writing a ledger's next content and putting it in place.
      const file = `${ledger}.0123456789ab.tmp`;
      writeFileSync(
        file,
        JSON.stringify({ version: 1, members: [{ pid, pgid: pid, startedAt: T1 }] }),
      );
      return file;
    };
    const deadLedger = createProcessLedger(dir, await deadPid());
    const deadNext = next(deadLedger, 400);
    const other = livePid();
    markDaemon(other);
    const liveNext = next(createProcessLedger(dir, other), 500);
    const report = await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
    expect(report).toEqual({ ledgers: 1, stopped: 0 });
    expect(world.has(400)).toBe(true);
    expect(existsSync(deadLedger)).toBe(false);
    expect(existsSync(deadNext)).toBe(false);
    // A running daemon's write is its own.
    expect(existsSync(liveNext)).toBe(true);
  });
});

describe('a sweep of the ledgers while the daemon runs', () => {
  /** Lets the round a timer started finish: everything it awaits is already settled. */
  const settle = () => new Promise((r) => setImmediate(r));
  const SWEEP_PAUSE = 30_000;

  it('stops what a kept ledger names once the machine can be read, and never touches a held one', async () => {
    const clock = new ManualClock();
    world.add(400, 1, 400); // an ended session's loop, kept when its end could not read the table
    world.add(500, 1, 500); // a running session's dev server
    const ledgerOf = (pid: number): string => {
      const file = createProcessLedger(dir, DAEMON);
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          daemonGroup: DAEMON_GROUP,
          members: [{ pid, pgid: pid, startedAt: T1 }],
        }),
      );
      return file;
    };
    const kept = ledgerOf(400);
    const held = ledgerOf(500);
    const readable = { now: false };
    const failures: unknown[] = [];
    const swept: unknown[] = [];
    const sweep = createLedgerSweep(
      dir,
      {
        ...deps({
          table: () => (readable.now ? world.table() : Promise.reject(new Error('ps failed'))),
        }),
        timers: clock,
      },
      { onSwept: (report) => swept.push(report), onFailed: (error) => failures.push(error) },
    );
    sweep.hold(held);
    sweep.later();
    clock.advance(SWEEP_PAUSE);
    await settle();
    expect(failures).toHaveLength(1);
    expect(world.has(400)).toBe(true);
    // It keeps trying while the table can't be read.
    readable.now = true;
    clock.advance(SWEEP_PAUSE);
    await settle();
    expect(world.has(400)).toBe(false);
    expect(existsSync(kept)).toBe(false);
    expect(swept).toEqual([{ ledgers: 1, stopped: 1 }]);
    expect(world.has(500)).toBe(true);
    expect(existsSync(held)).toBe(true);
    // Once a round has read the machine, nothing is armed until something else is kept.
    expect(clock.pendingTimers()).toBe(0);
    // A released ledger is a kept one.
    sweep.release(held);
    sweep.later();
    clock.advance(SWEEP_PAUSE);
    await settle();
    expect(world.has(500)).toBe(false);
    expect(existsSync(held)).toBe(false);
  });

  it('sweeps no more once stopped, even if a timer fires anyway, leaving what is kept for the next start', async () => {
    world.add(400, 1, 400);
    const kept = createProcessLedger(dir, DAEMON);
    writeFileSync(
      kept,
      JSON.stringify({ version: 1, members: [{ pid: 400, pgid: 400, startedAt: T1 }] }),
    );
    // Timers whose cancel does nothing, fired by hand.
    const armed: (() => void)[] = [];
    const sweep = createLedgerSweep(dir, {
      ...deps(),
      timers: {
        setTimeout(fn) {
          armed.push(fn);
          return { cancel: () => undefined };
        },
      },
    });
    sweep.later();
    sweep.stop();
    sweep.later();
    for (const fn of armed.splice(0)) fn();
    await settle();
    expect(world.has(400)).toBe(true);
    expect(existsSync(kept)).toBe(true);
  });
});
