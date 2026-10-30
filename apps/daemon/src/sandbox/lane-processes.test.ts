import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLaneProcessWatch,
  createProcessLedger,
  reapLaneProcessLedgers,
  removeProcessLedger,
  type LaneProcessDeps,
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
  cwdReads = 0;

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
  readonly cwds = (pids: readonly number[]): Promise<ReadonlyMap<number, string>> => {
    this.cwdReads += 1;
    const found = new Map<number, string>();
    for (const pid of pids) {
      const dir = this.cwd.get(pid);
      if (dir !== undefined && this.has(pid)) found.set(pid, dir);
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
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
    const WORKTREE = '/Users/me/.10db/worktrees/p/lane';
    const LANE_TMP = '/private/tmp/10db-abc123';
    const T2 = 'Thu Oct 30 12:00:07 2026';
    function setup(): void {
      world.add(200, DAEMON, DAEMON_GROUP); // claude, in the daemon's group as spawned
      // `pnpm dev > /dev/null 2>&1 &`: the command's shell (300) forked the job and exited within
      // milliseconds, before any sample; the job went to launchd.
      world.add(600, 1, 300, T2);
      world.cwd.set(600, `${WORKTREE}/apps/web`);
      world.add(601, 600, 300, T2); // what the job started
      // `(while :; do :; done) &` from the lane's temp dir.
      world.add(610, 1, 610, T2);
      world.cwd.set(610, LANE_TMP);
      // Not the lane's: a launchd job started meanwhile elsewhere, and one in the worktree from
      // before the session began.
      world.add(700, 1, 700, T2);
      world.cwd.set(700, '/Applications/Other.app');
      world.add(701, 1, 701, T0);
      world.cwd.set(701, WORKTREE);
      // A worktree whose name merely starts with this one's.
      world.add(702, 1, 702, T2);
      world.cwd.set(702, `${WORKTREE}-other`);
    }
    const watchDeps = (ledger: string | null = null) => ({
      ...deps(),
      cwds: world.cwds,
      places: [WORKTREE, LANE_TMP],
      ledger,
    });

    it('stops it when the session ends, by its working directory in the checkout or temp dir', async () => {
      setup();
      const watch = createLaneProcessWatch(watchDeps());
      await watch.track(ROOT);
      await watch.end();
      for (const pid of [600, 601, 610]) expect(world.has(pid)).toBe(false);
      for (const pid of [DAEMON, 700, 701, 702]) expect(world.has(pid)).toBe(true);
    });

    it('finds one that left between the last sample and the end', async () => {
      world.add(200, DAEMON, DAEMON_GROUP);
      const watch = createLaneProcessWatch(watchDeps());
      await watch.track(ROOT);
      world.add(600, 1, 300, T2);
      world.cwd.set(600, WORKTREE);
      await watch.end();
      expect(world.has(600)).toBe(false);
    });

    it('records it in the ledger, so a daemon that dies before the end still has it stopped', async () => {
      setup();
      const ledger = createProcessLedger(dir);
      await createLaneProcessWatch(watchDeps(ledger)).track(ROOT);
      const seen = JSON.parse(readFileSync(ledger, 'utf8')) as { members: { pid: number }[] };
      expect(seen.members.map((m) => m.pid)).toEqual(expect.arrayContaining([600, 601, 610]));
      world.die(200);
      await reapLaneProcessLedgers(dir, deps({ ownPid: 9999 }));
      for (const pid of [600, 601, 610]) expect(world.has(pid)).toBe(false);
      expect(world.has(700)).toBe(true);
    });

    it('reads each new orphan’s working directory once, not on every sample', async () => {
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
      const after = world.cwdReads;
      for (let n = 0; n < 3; n += 1) {
        ticks.shift()?.();
        await new Promise((r) => setImmediate(r));
      }
      expect(world.cwdReads).toBe(after);
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

  it('survives a table it cannot read: it stops nothing and says so', async () => {
    const watch = createLaneProcessWatch({
      ...deps({ table: () => Promise.reject(new Error('ps failed')) }),
      ledger: null,
    });
    await expect(watch.track(ROOT)).resolves.toBeUndefined();
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
    writeFileSync(join(dir, '10db-proc-0123456789ab.json'), '{not json');
    writeFileSync(join(dir, '10db-proc-notahexid.json'), '{"version":1,"members":[]}');
    writeFileSync(join(dir, 'unrelated.json'), '{}');
    const report = await reapLaneProcessLedgers(dir, deps());
    expect(report.ledgers).toBe(1);
    expect(existsSync(join(dir, '10db-proc-0123456789ab.json'))).toBe(false);
    expect(existsSync(join(dir, '10db-proc-notahexid.json'))).toBe(true);
    expect(existsSync(join(dir, 'unrelated.json'))).toBe(true);
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
});
