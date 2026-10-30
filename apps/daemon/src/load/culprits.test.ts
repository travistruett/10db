import { describe, expect, it } from 'vitest';
import {
  findCulprits,
  parsePs,
  type KnownProcesses,
  type ProcessRow,
  type ProcessSnapshot,
} from './culprits';

const TEMP_ROOT = '/private/tmp';

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  cpu: number,
  command: string,
): ProcessRow => ({
  pid,
  ppid,
  pgid,
  cpu,
  command,
});

const NO_KNOWN: KnownProcesses = {
  daemonPid: 100,
  tempRoot: TEMP_ROOT,
  sessions: [],
  gates: [],
  tempDirs: [],
  worktrees: [],
};

function snapshot(
  rows: readonly ProcessRow[],
  files: Record<number, readonly string[]> = {},
): ProcessSnapshot {
  return {
    rows: () => Promise.resolve(rows),
    files: (pids) => Promise.resolve(new Map(pids.map((pid) => [pid, files[pid] ?? []] as const))),
  };
}

describe('parsePs', () => {
  it('reads pid, parent, group, CPU and the whole command line, spaces included', () => {
    const out = [
      '  101     1   101  99.3 /bin/sh -c while true; do :; done',
      '    7     1     7   0.0 launchd',
      'garbage line',
      '',
    ].join('\n');
    expect(parsePs(out)).toEqual([
      row(101, 1, 101, 99.3, '/bin/sh -c while true; do :; done'),
      row(7, 1, 7, 0, 'launchd'),
    ]);
  });
});

describe('findCulprits', () => {
  it('lists the processes using the most CPU first, at most `top` of them', async () => {
    const rows = [
      row(1, 0, 1, 5, 'a'),
      row(2, 0, 2, 90, 'b'),
      row(3, 0, 3, 40, 'c'),
      row(4, 0, 4, 60, 'd'),
    ];
    const found = await findCulprits(snapshot(rows), () => NO_KNOWN, { top: 3, minCpu: 1 });
    expect(found.map((c) => c.pid)).toEqual([2, 4, 3]);
    expect(found[0]).toMatchObject({ pid: 2, cpu: 90, command: 'b' });
  });

  it('leaves out processes that are barely using the CPU', async () => {
    const rows = [row(1, 0, 1, 0.4, 'idle'), row(2, 0, 2, 70, 'busy')];
    const found = await findCulprits(snapshot(rows), () => NO_KNOWN);
    expect(found.map((c) => c.pid)).toEqual([2]);
  });

  it('shortens a very long command line', async () => {
    const rows = [row(2, 0, 2, 70, `node ${'x'.repeat(500)}`)];
    const [found] = await findCulprits(snapshot(rows), () => NO_KNOWN);
    expect(found?.command.length).toBeLessThanOrEqual(120);
  });

  it('says a process nothing of 10db is behind is not 10db’s', async () => {
    const found = await findCulprits(snapshot([row(9, 1, 9, 90, 'yes')]), () => NO_KNOWN);
    expect(found[0]?.owner).toEqual({ kind: 'other' });
  });

  it('names the lane whose session process is the busy one', async () => {
    const known: KnownProcesses = {
      ...NO_KNOWN,
      sessions: [{ pid: 9, workstreamId: 'ws_1', label: 'task "Fix login"' }],
    };
    const found = await findCulprits(snapshot([row(9, 100, 100, 90, 'claude')]), () => known);
    expect(found[0]?.owner).toEqual({
      kind: 'lane',
      workstreamId: 'ws_1',
      label: 'task "Fix login"',
    });
  });

  it('names the lane that a busy child of its session belongs to, however deep', async () => {
    const known: KnownProcesses = {
      ...NO_KNOWN,
      sessions: [{ pid: 20, workstreamId: 'ws_1', label: 'task "Fix login"' }],
    };
    const rows = [
      row(20, 100, 100, 1, 'claude'),
      row(21, 20, 100, 1, 'zsh'),
      row(22, 21, 100, 95, 'node test.js'),
    ];
    const found = await findCulprits(snapshot(rows), () => known);
    expect(found.map((c) => c.pid)).toEqual([22]);
    expect(found[0]?.owner).toMatchObject({ kind: 'lane', workstreamId: 'ws_1' });
  });

  it('names the gate whose process group a busy process is in', async () => {
    const known: KnownProcesses = {
      ...NO_KNOWN,
      gates: [{ pid: 300, label: 'the shipping gate of batch "Greetings"' }],
    };
    // The leader has exited; its children keep the group.
    const found = await findCulprits(snapshot([row(305, 1, 300, 88, 'vitest')]), () => known);
    expect(found[0]?.owner).toEqual({
      kind: 'gate',
      label: 'the shipping gate of batch "Greetings"',
    });
  });

  it('names the lane whose temp dir an orphaned busy loop holds open', async () => {
    const known: KnownProcesses = {
      ...NO_KNOWN,
      tempDirs: [{ dir: '/private/tmp/10db-abc123', workstreamId: 'ws_7', label: 'task "Slow"' }],
    };
    const found = await findCulprits(
      snapshot([row(500, 1, 500, 99, 'sh loop.sh')], {
        500: ['/usr/lib/dyld', '/private/tmp/10db-abc123/work/loop.sh'],
      }),
      () => known,
    );
    expect(found[0]?.owner).toEqual({ kind: 'lane', workstreamId: 'ws_7', label: 'task "Slow"' });
  });

  it('says a busy process in a lane temp dir that no lane owns now was left behind by one that ended', async () => {
    const found = await findCulprits(
      snapshot([row(500, 1, 500, 99, 'sh loop.sh')], {
        500: ['/private/tmp/10db-gone99/loop.sh'],
      }),
      () => NO_KNOWN,
    );
    expect(found[0]?.owner).toEqual({ kind: 'ended-lane' });
  });

  it('does not treat a similarly named directory as a lane temp dir', async () => {
    const found = await findCulprits(
      snapshot([row(500, 1, 500, 99, 'sh')], { 500: ['/private/tmp/10db-abc123-other/x'] }),
      () => ({
        ...NO_KNOWN,
        tempDirs: [{ dir: '/private/tmp/10db-abc123', workstreamId: 'ws_7', label: 'task' }],
      }),
    );
    expect(found[0]?.owner).toEqual({ kind: 'ended-lane' });
  });

  it('names the lane whose worktree a busy process works in', async () => {
    const known: KnownProcesses = {
      ...NO_KNOWN,
      worktrees: [
        { path: '/home/me/.10db/worktrees/p/b1', workstreamId: 'ws_2', label: 'task "Add form"' },
      ],
    };
    const found = await findCulprits(
      snapshot([row(600, 1, 600, 97, 'node')], {
        600: ['/home/me/.10db/worktrees/p/b1/apps/web'],
      }),
      () => known,
    );
    expect(found[0]?.owner).toEqual({
      kind: 'lane',
      workstreamId: 'ws_2',
      label: 'task "Add form"',
    });
  });

  it('says 10db itself when the daemon, or something it started that is no lane or gate, is busy', async () => {
    const rows = [row(100, 1, 100, 80, 'node daemon.mjs'), row(101, 100, 100, 90, 'git gc')];
    const found = await findCulprits(snapshot(rows), () => NO_KNOWN);
    expect(found.map((c) => c.owner.kind)).toEqual(['daemon', 'daemon']);
  });

  it('reads open files only for the processes it lists, and survives not being able to', async () => {
    const asked: number[][] = [];
    const source: ProcessSnapshot = {
      rows: () => Promise.resolve([row(1, 0, 1, 2, 'a'), row(2, 1, 2, 90, 'b')]),
      files: (pids) => {
        asked.push([...pids]);
        return Promise.reject(new Error('lsof is not available'));
      },
    };
    const found = await findCulprits(source, () => NO_KNOWN);
    expect(asked).toEqual([[2]]);
    expect(found[0]?.owner).toEqual({ kind: 'other' });
  });

  it('survives a parent loop in the process table', async () => {
    const rows = [row(5, 6, 5, 90, 'a'), row(6, 5, 6, 90, 'b')];
    const found = await findCulprits(snapshot(rows), () => NO_KNOWN);
    expect(found).toHaveLength(2);
  });
});
