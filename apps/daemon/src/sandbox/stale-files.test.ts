import { spawn, type ChildProcess } from 'node:child_process';
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
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimSandboxRoots, claimSandboxTempRoot } from './index';

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
      expect(claim).toMatchObject({ removed: 6, failed: 0, sharedWith: null });
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
      expect(claim).toMatchObject({ removed: 6, sharedWith: null });
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

describe('claimSandboxRoots', () => {
  /** The roots a daemon claims, and the old one it only sweeps: `/private/tmp`, here injected. */
  function roots(): { temp: string; lanes: string; files: string; old: string } {
    const made = {
      temp: join(base, 'shared'),
      lanes: join(base, 'lanes'),
      files: join(base, 'run'),
      old: join(base, 'old-tmp'),
    };
    for (const dir of Object.values(made)) mkdirSync(dir);
    return made;
  }

  it('sweeps stale temp dirs and sealed files from every root, and ledgers too from the old /private/tmp, marking only the roots it claims', async () => {
    const { temp, lanes, files, old } = roots();
    leaveStaleFiles(temp);
    mkdirSync(join(lanes, '10db-Qq1Ww2', 'cache'), { recursive: true });
    leaveStaleFiles(files);
    for (const name of LEDGERS) writeFileSync(join(files, name), '{"version":1,"members":[]}');
    leaveStaleFiles(old);
    for (const name of LEDGERS) writeFileSync(join(old, name), '{"version":1,"members":[]}');
    const dead = await deadPid();
    writeFileSync(join(old, `10db-daemon-${String(dead)}`), '', { mode: 0o400 });
    const others = leaveOthers(old);
    const mark = `10db-daemon-${String(process.pid)}`;
    const claim = claimSandboxRoots([temp, lanes, files], old, process.pid);
    try {
      // Six in each of three roots, one in the lanes root, and the old root's two ledger files.
      expect(claim).toMatchObject({ removed: 21, failed: 0, sharedWith: null });
      expect(readdirSync(temp)).toEqual([mark]);
      expect(readdirSync(lanes)).toEqual([mark]);
      // The files root's ledgers are for the sweep that stops their processes.
      expect(readdirSync(files).sort()).toEqual([...LEDGERS, mark].sort());
      // Nothing of 10db's is left where every ChatGPT lane can read and write, and no mark either:
      // no sandbox file is made there any more, and its ledgers are never read.
      expect(readdirSync(old).sort()).toEqual(others);
      expect(readdirSync(outside)).toEqual(['keep.txt']);
    } finally {
      claim.release();
    }
    for (const dir of [temp, lanes]) expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(files).sort()).toEqual([...LEDGERS].sort());
  });

  it('leaves the old root alone while an earlier daemon that still runs has marked it, and claims the others', () => {
    const { temp, lanes, files, old } = roots();
    leaveStaleFiles(temp);
    leaveStaleFiles(old);
    for (const name of LEDGERS) writeFileSync(join(old, name), '{"version":1,"members":[]}');
    const earlier = liveProcess();
    writeFileSync(join(old, `10db-daemon-${String(earlier)}`), '', { mode: 0o400 });
    const before = readdirSync(old).sort();
    const claim = claimSandboxRoots([temp, lanes, files], old, process.pid);
    try {
      expect(claim).toMatchObject({ removed: 6, sharedWith: earlier });
      expect(readdirSync(old).sort()).toEqual(before);
      expect(readdirSync(temp)).toEqual([`10db-daemon-${String(process.pid)}`]);
    } finally {
      claim.release();
    }
  });
});
