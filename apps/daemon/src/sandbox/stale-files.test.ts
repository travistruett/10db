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
import { claimSandboxTempRoot } from './index';

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
  const locked = join(root, '10db-Zz9yX8', 'locked');
  if (existsSync(join(root, '10db-Zz9yX8'))) chmodSync(locked, 0o700);
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
function leaveStaleFiles(): void {
  mkdirSync(join(root, '10db-a1B2c3', 'cache', 'npm'), { recursive: true });
  writeFileSync(join(root, '10db-a1B2c3', 'cache', 'npm', 'x'), '');
  mkdirSync(join(root, '10db-Zz9yX8', 'locked'), { recursive: true });
  chmodSync(join(root, '10db-Zz9yX8', 'locked'), 0o000);
  for (const name of [
    '10db-env-0123456789ab.sh',
    '10db-gate-0123456789ab.json',
    '10db-mcp-0123456789ab.json',
    '10db-mcp-ba9876543210.sh',
  ])
    writeFileSync(join(root, name), "export A='1'\n", { mode: 0o400 });
}

/** Names that aren't 10db's, or are 10db's names on something 10db never makes. */
function leaveOthers(): string[] {
  writeFileSync(join(root, 'other.txt'), '');
  writeFileSync(join(root, '10db-notes.txt'), '');
  mkdirSync(join(root, '10db-toolongname'));
  mkdirSync(join(root, '10db-mcp-0123456789cd.sh'));
  symlinkSync(outside, join(root, '10db-L1nk00'));
  symlinkSync(join(outside, 'keep.txt'), join(root, '10db-env-00000000000a.sh'));
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

  it('claims a missing root without throwing', () => {
    const claim = claimSandboxTempRoot(join(base, 'missing'), process.pid);
    expect(claim).toMatchObject({ removed: 0, failed: 0, sharedWith: null });
    claim.release();
  });
});
