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

/**
 * The temp dirs a crashed daemon leaves: in a sandbox root `createLaneTempDir`'s six characters,
 * in a system temp dir the `10db-` and six characters a daemon that made them there used.
 */
const LANE_DIRS = ['a1B2c3', 'Zz9yX8'] as const;
const SYSTEM_DIRS = ['10db-a1B2c3', '10db-Zz9yX8'] as const;

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of readdirSync(base)) {
    for (const name of [LANE_DIRS[1], SYSTEM_DIRS[1]]) {
      const locked = join(base, dir, name, 'locked');
      if (existsSync(locked)) chmodSync(locked, 0o700);
    }
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
function leaveStaleFiles(dir: string = root, names: readonly string[] = LANE_DIRS): void {
  const [open, locked] = names;
  if (open === undefined || locked === undefined) throw new Error('two temp dir names');
  mkdirSync(join(dir, open, 'cache', 'npm'), { recursive: true });
  writeFileSync(join(dir, open, 'cache', 'npm', 'x'), '');
  mkdirSync(join(dir, locked, 'locked'), { recursive: true });
  chmodSync(join(dir, locked, 'locked'), 0o000);
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

/**
 * Names that aren't 10db's, or are 10db's names on something 10db never makes there: a temp dir
 * named as the other kind of root names one (`foreign`), a longer name, a link with a temp dir's name.
 */
function leaveOthers(dir: string = root, foreign: string = SYSTEM_DIRS[0]): string[] {
  const link = foreign === SYSTEM_DIRS[0] ? 'L1nk00' : '10db-L1nk00';
  // The marker a sandbox root holds to keep Spotlight out.
  writeFileSync(join(dir, '.metadata_never_index'), '');
  writeFileSync(join(dir, 'other.txt'), '');
  writeFileSync(join(dir, '10db-notes.txt'), '');
  mkdirSync(join(dir, foreign));
  mkdirSync(join(dir, 'a1B2c3d'));
  mkdirSync(join(dir, '10db-toolongname'));
  mkdirSync(join(dir, '10db-mcp-0123456789cd.sh'));
  symlinkSync(outside, join(dir, link));
  symlinkSync(join(outside, 'keep.txt'), join(dir, '10db-env-00000000000a.sh'));
  return [
    '.metadata_never_index',
    link,
    foreign,
    'a1B2c3d',
    '10db-env-00000000000a.sh',
    '10db-mcp-0123456789cd.sh',
    '10db-notes.txt',
    '10db-toolongname',
    'other.txt',
  ].sort();
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
    const missing = claimSandboxTempRoot(join(base, 'missing'), process.pid);
    expect(missing).toMatchObject({ removed: 0, failed: 0, sharedWith: null });
    missing.release();
  });

  it('leaves the temp dirs a live takeover names, and removes the others', () => {
    leaveStaleFiles();
    const kept = join(root, LANE_DIRS[0]);
    const claim = claimSandboxTempRoot(
      root,
      process.pid,
      'temp',
      new Set([kept, join(outside, 'x')]),
    );
    try {
      expect(existsSync(kept)).toBe(true);
      expect(existsSync(join(root, LANE_DIRS[1]))).toBe(false);
    } finally {
      claim.release();
    }
  });

  it("removes nothing while another daemon's mark names a live process, and sweeps past a dead one's, removing the mark", async () => {
    const mine = `10db-daemon-${String(process.pid)}`;
    // A live mark: its sessions may be running.
    const shared = join(base, 'shared');
    mkdirSync(shared);
    leaveStaleFiles(shared);
    const other = liveProcess();
    writeFileSync(join(shared, `10db-daemon-${String(other)}`), '', { mode: 0o400 });
    const before = readdirSync(shared).sort();
    const held = claimSandboxTempRoot(shared, process.pid);
    try {
      expect(held).toMatchObject({ removed: 0, sharedWith: other });
      expect(readdirSync(shared).sort()).toEqual([...before, mine].sort());
    } finally {
      held.release();
    }
    leaveStaleFiles();
    const dead = await deadPid();
    writeFileSync(join(root, `10db-daemon-${String(dead)}`), '', { mode: 0o400 });
    const claim = claimSandboxTempRoot(root, process.pid);
    try {
      expect(claim).toMatchObject({ removed: 8, sharedWith: null });
      expect(readdirSync(root)).toEqual([mine]);
    } finally {
      claim.release();
    }
    expect(existsSync(join(root, mine))).toBe(false);
  });

  it("sweeps a dead daemon's session dirs and env files from the files root only, and leaves its ledgers and a live daemon's dirs", async () => {
    const rows: {
      name: string;
      /** Lays out the entry in `dir` and returns its path. */
      make: (dir: string) => string;
      daemon: 'dead' | 'live' | null;
      kind: 'temp' | 'files';
      kept: boolean;
    }[] = [
      ...(
        [
          [
            'a dead daemon’s setup dir is swept from the files root',
            'setup',
            'dead',
            'files',
            false,
          ],
          ['a live daemon’s setup dir is kept', 'setup', 'live', 'files', true],
          [
            'a setup dir in a temp root, which lanes write, is never touched',
            'setup',
            'dead',
            'temp',
            true,
          ],
          [
            'a dead daemon’s secret reads are swept from the files root',
            'read',
            'dead',
            'files',
            false,
          ],
          ['secret reads in a temp root are never touched', 'read', 'dead', 'temp', true],
        ] as const
      ).map(([name, prefix, daemon, kind, kept]) => ({
        name,
        make: (dir: string) => {
          const setup = join(dir, `10db-${prefix}-0123456789ab`);
          mkdirSync(join(setup, 'yours/skills'), { recursive: true });
          symlinkSync(outside, join(setup, 'yours/skills/s'));
          return setup;
        },
        daemon,
        kind,
        kept,
      })),
      {
        name: 'a dead daemon’s 10db-ymcp env file is swept from the files root',
        make: (dir) => {
          const envFile = join(dir, '10db-ymcp-0123456789ab.sh');
          writeFileSync(envFile, "export TOKEN='x'\n", { mode: 0o400 });
          return envFile;
        },
        daemon: 'dead',
        kind: 'files',
        kept: false,
      },
      {
        // `reapLaneProcessLedgers` reads them next, then removes them; the claim must not.
        name: "a dead daemon's process ledger is left for the sweep that stops its processes",
        make: (dir) => {
          const ledger = join(dir, '10db-proc-4321-0123456789ab.json');
          writeFileSync(ledger, '{"version":1,"members":[]}');
          return ledger;
        },
        daemon: null,
        kind: 'temp',
        kept: true,
      },
    ];
    for (const [i, row] of rows.entries()) {
      const dir = join(base, `row-${String(i)}`);
      mkdirSync(dir);
      const entry = row.make(dir);
      if (row.daemon !== null) {
        const owner = row.daemon === 'dead' ? await deadPid() : liveProcess();
        writeFileSync(join(dir, `10db-daemon-${String(owner)}`), '', { mode: 0o400 });
      }
      const claim = claimSandboxTempRoot(dir, process.pid, row.kind);
      try {
        expect.soft(existsSync(entry), row.name).toBe(row.kept);
        expect.soft(readdirSync(outside), row.name).toEqual(['keep.txt']);
      } finally {
        claim.release();
      }
    }
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
    mkdirSync(join(lanes, 'Qq1Ww2', 'cache'), { recursive: true });
    leaveStaleFiles(files);
    for (const name of LEDGERS) writeFileSync(join(files, name), '{"version":1,"members":[]}');
    const mark = `10db-daemon-${String(process.pid)}`;
    const claim = claimSandboxRoots({ temps: [temp, lanes], files }, process.pid);
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
    "removes 10db's sealed files and ledgers from a system temp dir at once, unread, then its temp dirs off the event loop, stopping when aborted, whatever a mark of no 10db daemon says",
    async () => {
      const { systemTemp } = roots();
      leaveStaleFiles(systemTemp, SYSTEM_DIRS);
      for (const name of LEDGERS)
        writeFileSync(join(systemTemp, name), '{"version":1,"members":[]}');
      // A mark a ChatGPT lane could plant: a running process, but no 10db daemon.
      const planted = liveProcess();
      writeFileSync(join(systemTemp, `10db-daemon-${String(planted)}`), '', { mode: 0o400 });
      // A dir with a sandbox root's temp dir name is no 10db name in a system temp dir.
      const others = leaveOthers(systemTemp, LANE_DIRS[0]);
      // Six sealed files and the two ledger files; the temp dirs are the later sweep's.
      expect(sweepSystemTempFiles([systemTemp])).toMatchObject({ removed: 8, failed: 0 });
      expect(readdirSync(systemTemp).sort()).toEqual(
        [...others, ...SYSTEM_DIRS, `10db-daemon-${String(planted)}`].sort(),
      );
      expect(readdirSync(outside)).toEqual(['keep.txt']);
      const aborted = new AbortController();
      aborted.abort();
      expect(await sweepSystemTempDirs([systemTemp], aborted.signal)).toMatchObject({ removed: 0 });
      expect(readdirSync(systemTemp)).toEqual(expect.arrayContaining([...SYSTEM_DIRS]));
      let ticked = false;
      const sweeping = sweepSystemTempDirs([systemTemp], new AbortController().signal);
      setImmediate(() => {
        ticked = true;
      });
      expect(await sweeping).toMatchObject({ removed: 2, failed: 0 });
      expect(ticked).toBe(true);
      for (const name of SYSTEM_DIRS) expect(readdirSync(systemTemp)).not.toContain(name);
      expect(readdirSync(systemTemp)).toEqual(expect.arrayContaining(others));
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    },
  );

  // `ps` names another process's entry only outside a sandbox.
  it.skipIf(SANDBOXED)(
    'leaves a system temp dir alone while a 10db daemon that runs has marked it',
    async () => {
      const { systemTemp } = roots();
      leaveStaleFiles(systemTemp, SYSTEM_DIRS);
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
