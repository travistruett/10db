import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOXED, waitFor } from '../../test/fixtures';
import {
  claimSandboxRoots,
  claimSandboxTempRoot,
  sweepSystemTempDirs,
  sweepSystemTempFiles,
} from './index';

let base: string;
let root: string;
let outside: string;
let children: ChildProcess[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), '10db-sweep-')));
  root = join(base, 't');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  children = [];
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of readdirSync(base)) {
    const locked = join(base, dir, '10db-Zz9yX8', 'locked');
    if (existsSync(join(base, dir, '10db-Zz9yX8'))) chmodSync(locked, 0o700);
  }
  rmSync(base, { recursive: true, force: true });
});

/** A process that stays alive until the test ends, standing in for another daemon. */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  if (child.pid === undefined) throw new Error('no pid');
  return child.pid;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => child.once('exit', resolve));
  if (pid === undefined) throw new Error('no pid');
  return pid;
}

/** What a crashed daemon leaves: temp dirs (one locked down by its lane) and sealed files. */
function leaveStaleFiles(dir: string = root): void {
  mkdirSync(join(dir, '10db-a1B2c3', 'cache', 'npm'), { recursive: true });
  writeFileSync(join(dir, '10db-a1B2c3', 'cache', 'npm', 'x'), '');
  mkdirSync(join(dir, '10db-Zz9yX8', 'locked'), { recursive: true });
  chmodSync(join(dir, '10db-Zz9yX8', 'locked'), 0o000);
  for (const name of [
    '10db-env-0123456789ab.sh',
    '10db-gate-0123456789ab.json',
    '10db-mcp-0123456789ab.json',
    '10db-mcp-ba9876543210.sh',
    '10db-mcp-0123456789ef.cjs',
    '10db-mcp-fedcba987654.log',
  ])
    writeFileSync(join(dir, name), "export A='1'\n", { mode: 0o400 });
}

/** A dead daemon's process ledger and the next content it was writing to it. */
const LEDGERS = [
  '10db-proc-4321-0123456789ab.json',
  '10db-proc-4321-0123456789ab.json.ba9876543210.tmp',
];

/** Names that aren't 10db's, or are 10db's names on something 10db never makes. */
function leaveOthers(dir: string = root): string[] {
  writeFileSync(join(dir, 'other.txt'), '');
  writeFileSync(join(dir, '10db-notes.txt'), '');
  mkdirSync(join(dir, '10db-toolongname'));
  mkdirSync(join(dir, '10db-mcp-0123456789cd.sh'));
  symlinkSync(outside, join(dir, '10db-L1nk00'));
  symlinkSync(join(outside, 'keep.txt'), join(dir, '10db-env-00000000000a.sh'));
  return [
    '10db-L1nk00',
    '10db-env-00000000000a.sh',
    '10db-mcp-0123456789cd.sh',
    '10db-notes.txt',
    '10db-toolongname',
    'other.txt',
  ];
}

describe('claimSandboxTempRoot', () => {
  it("removes a crashed daemon's temp dirs and sealed files, and nothing else, without following a link", () => {
    leaveStaleFiles();
    const others = leaveOthers();
    const claim = claimSandboxTempRoot(root, process.pid);
    try {
      expect(claim).toMatchObject({ removed: 8, failed: 0, sharedWith: null });
      expect(readdirSync(root).sort()).toEqual(
        [...others, `10db-daemon-${String(process.pid)}`].sort(),
      );
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    } finally {
      claim.release();
    }
    expect(readdirSync(root).sort()).toEqual(others);
  });

  it("removes nothing while another daemon's mark names a live process, since its sessions may be running", () => {
    leaveStaleFiles();
    const other = liveProcess();
    writeFileSync(join(root, `10db-daemon-${String(other)}`), '', { mode: 0o400 });
    const before = readdirSync(root).sort();
    const claim = claimSandboxTempRoot(root, process.pid);
    try {
      expect(claim).toMatchObject({ removed: 0, sharedWith: other });
      expect(readdirSync(root).sort()).toEqual(
        [...before, `10db-daemon-${String(process.pid)}`].sort(),
      );
    } finally {
      claim.release();
    }
  });

  it("sweeps past a dead daemon's mark, and removes the mark", async () => {
    leaveStaleFiles();
    const dead = await deadPid();
    writeFileSync(join(root, `10db-daemon-${String(dead)}`), '', { mode: 0o400 });
    const claim = claimSandboxTempRoot(root, process.pid);
    try {
      expect(claim).toMatchObject({ removed: 8, sharedWith: null });
      expect(readdirSync(root)).toEqual([`10db-daemon-${String(process.pid)}`]);
    } finally {
      claim.release();
    }
    expect(existsSync(join(root, `10db-daemon-${String(process.pid)}`))).toBe(false);
  });

  it("leaves a dead daemon's process ledgers for the sweep that stops their processes", () => {
    // `reapLaneProcessLedgers` reads them next, then removes them; the claim must not.
    writeFileSync(join(root, '10db-proc-4321-0123456789ab.json'), '{"version":1,"members":[]}');
    const claim = claimSandboxTempRoot(root, process.pid);
    try {
      expect(readdirSync(root).sort()).toEqual([
        `10db-daemon-${String(process.pid)}`,
        '10db-proc-4321-0123456789ab.json',
      ]);
    } finally {
      claim.release();
    }
  });

  it('claims a missing root without throwing', () => {
    const claim = claimSandboxTempRoot(join(base, 'missing'), process.pid);
    expect(claim).toMatchObject({ removed: 0, failed: 0, sharedWith: null });
    claim.release();
  });
});

describe('claimSandboxRoots and the system temp sweeps', () => {
  /** The roots a daemon claims, and a system temp dir it only sweeps, here stand-ins. */
  function roots(): { temp: string; lanes: string; files: string; systemTemp: string } {
    const made = {
      temp: join(base, 'shared'),
      lanes: join(base, 'lanes'),
      files: join(base, 'run'),
      systemTemp: join(base, 'system-tmp'),
    };
    for (const dir of Object.values(made)) mkdirSync(dir);
    return made;
  }

  it('sweeps stale temp dirs and sealed files from every root it claims, leaves their ledgers for the reap, and marks each', () => {
    const { temp, lanes, files } = roots();
    leaveStaleFiles(temp);
    mkdirSync(join(lanes, '10db-Qq1Ww2', 'cache'), { recursive: true });
    leaveStaleFiles(files);
    for (const name of LEDGERS) writeFileSync(join(files, name), '{"version":1,"members":[]}');
    const mark = `10db-daemon-${String(process.pid)}`;
    const claim = claimSandboxRoots([temp, lanes, files], process.pid);
    try {
      // Eight in the temp root, one in the lanes root, eight in the files root.
      expect(claim).toMatchObject({ removed: 17, failed: 0, sharedWith: null });
      expect(readdirSync(temp)).toEqual([mark]);
      expect(readdirSync(lanes)).toEqual([mark]);
      expect(readdirSync(files).sort()).toEqual([...LEDGERS, mark].sort());
    } finally {
      claim.release();
    }
    for (const dir of [temp, lanes]) expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(files).sort()).toEqual([...LEDGERS].sort());
  });

  /** A process running a 10db daemon's entry, as a bundle runs `daemon.mjs`. */
  function liveDaemon(): number {
    const entry = join(base, 'app', 'daemon.mjs');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'setInterval(() => undefined, 1000);\n');
    const child = spawn(process.execPath, [entry], { stdio: 'ignore' });
    children.push(child);
    if (child.pid === undefined) throw new Error('no pid');
    return child.pid;
  }

  /** Waits until `pid`'s command line is the one it was spawned with, so `ps` names its entry. */
  const running = (pid: number, entry: RegExp): Promise<boolean> =>
    waitFor(() =>
      entry.test(
        execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }),
      ),
    );

  // Inside a sandbox `ps` can't run, so every live mark counts there.
  it.skipIf(SANDBOXED)(
    "removes 10db's sealed files and ledgers from a system temp dir at once, unread, whatever a mark of no 10db daemon says",
    () => {
      const { systemTemp } = roots();
      leaveStaleFiles(systemTemp);
      for (const name of LEDGERS)
        writeFileSync(join(systemTemp, name), '{"version":1,"members":[]}');
      // A mark a ChatGPT lane could plant: a running process, but no 10db daemon.
      const planted = liveProcess();
      writeFileSync(join(systemTemp, `10db-daemon-${String(planted)}`), '', { mode: 0o400 });
      const others = leaveOthers(systemTemp);
      // Six sealed files and the two ledger files; the temp dirs are the later sweep's.
      expect(sweepSystemTempFiles([systemTemp])).toMatchObject({ removed: 8, failed: 0 });
      expect(readdirSync(systemTemp).sort()).toEqual(
        [...others, '10db-Zz9yX8', '10db-a1B2c3', `10db-daemon-${String(planted)}`].sort(),
      );
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    },
  );

  // Inside a sandbox `ps` can't run, so every live mark counts there.
  it.skipIf(SANDBOXED)(
    "removes 10db's temp dirs from a system temp dir off the event loop, whatever a mark of no 10db daemon says, and stops when aborted",
    async () => {
      const { systemTemp } = roots();
      leaveStaleFiles(systemTemp);
      const planted = liveProcess();
      writeFileSync(join(systemTemp, `10db-daemon-${String(planted)}`), '', { mode: 0o400 });
      const others = leaveOthers(systemTemp);
      const aborted = new AbortController();
      aborted.abort();
      expect(await sweepSystemTempDirs([systemTemp], aborted.signal)).toMatchObject({ removed: 0 });
      expect(readdirSync(systemTemp)).toEqual(
        expect.arrayContaining(['10db-Zz9yX8', '10db-a1B2c3']),
      );
      let ticked = false;
      const sweeping = sweepSystemTempDirs([systemTemp], new AbortController().signal);
      setImmediate(() => {
        ticked = true;
      });
      expect(await sweeping).toMatchObject({ removed: 2, failed: 0 });
      expect(ticked).toBe(true);
      expect(readdirSync(systemTemp)).not.toContain('10db-Zz9yX8');
      expect(readdirSync(systemTemp)).not.toContain('10db-a1B2c3');
      expect(readdirSync(systemTemp)).toEqual(expect.arrayContaining(others));
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    },
  );

  // `ps` names another process's entry only outside a sandbox.
  it.skipIf(SANDBOXED)(
    'leaves a system temp dir alone while a 10db daemon that runs has marked it',
    async () => {
      const { systemTemp } = roots();
      leaveStaleFiles(systemTemp);
      for (const name of LEDGERS)
        writeFileSync(join(systemTemp, name), '{"version":1,"members":[]}');
      const daemon = liveDaemon();
      await running(daemon, /daemon\.mjs/);
      writeFileSync(join(systemTemp, `10db-daemon-${String(daemon)}`), '', { mode: 0o400 });
      const before = readdirSync(systemTemp).sort();
      expect(sweepSystemTempFiles([systemTemp])).toMatchObject({ removed: 0, sharedWith: daemon });
      expect(await sweepSystemTempDirs([systemTemp], new AbortController().signal)).toMatchObject({
        removed: 0,
        sharedWith: daemon,
      });
      expect(readdirSync(systemTemp).sort()).toEqual(before);
    },
  );
});
