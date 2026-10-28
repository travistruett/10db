import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { seedDirs, seedWorktree } from './worktree-seed';

describe('seedDirs', () => {
  it.each([
    ['top level', ['node_modules', 'dist'], ['node_modules'], ['node_modules']],
    [
      'nested in a tracked directory',
      ['apps/web/node_modules'],
      ['node_modules'],
      ['apps/web/node_modules'],
    ],
    [
      'matches the last component only',
      ['node_modules-old', 'x/node_modules/y'],
      ['node_modules'],
      [],
    ],
    [
      'drops one inside another chosen dir',
      ['node_modules', 'node_modules/.pnpm/node_modules'],
      ['node_modules'],
      ['node_modules'],
    ],
    [
      'drops the inner one whichever comes first',
      ['node_modules/.pnpm/node_modules', 'node_modules'],
      ['node_modules'],
      ['node_modules'],
    ],
    [
      'keeps a sibling that only shares a prefix',
      ['target', 'target-old/node_modules'],
      ['target', 'node_modules'],
      ['target', 'target-old/node_modules'],
    ],
    [
      'several names',
      ['node_modules', 'target'],
      ['node_modules', 'target'],
      ['node_modules', 'target'],
    ],
    ['a trailing slash', ['node_modules/'], ['node_modules'], ['node_modules']],
  ])('%s', (_name, ignored, names, expected) => {
    expect(seedDirs(ignored, names)).toEqual(expected);
  });
});

describe('seedWorktree', () => {
  let tmp: ReturnType<typeof tempDir>;
  let from: string;
  let to: string;
  const signal = new AbortController().signal;
  beforeEach(() => {
    tmp = tempDir('seed');
    from = join(tmp.path, 'from');
    to = join(tmp.path, 'to');
    mkdirSync(from);
    mkdirSync(to);
  });
  afterEach(() => {
    // Modes the tests lowered would stop the cleanup.
    execFileSync('chmod', ['-R', 'u+rwx', tmp.path]);
    tmp.cleanup();
  });

  it('clones regular files with their bytes and mode', async () => {
    mkdirSync(join(from, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(from, 'node_modules', 'pkg', 'a.js'), 'console.log(1)');
    writeFileSync(join(from, 'node_modules', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(join(from, 'node_modules', 'run.sh'), 0o755);
    const result = await seedWorktree({ from, to, dirs: ['node_modules'], signal });
    expect(result).toEqual({ files: 2, links: 0, skipped: [] });
    expect(readFileSync(join(to, 'node_modules', 'pkg', 'a.js'), 'utf8')).toBe('console.log(1)');
    expect(lstatSync(join(to, 'node_modules', 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('makes directories with their mode, a read-only one included', async () => {
    mkdirSync(join(from, 'node_modules', 'ro'), { recursive: true });
    mkdirSync(join(from, 'node_modules', 'exec-only'));
    writeFileSync(join(from, 'node_modules', 'ro', 'f'), 'x');
    writeFileSync(join(from, 'node_modules', 'exec-only', 'f'), 'y');
    chmodSync(join(from, 'node_modules', 'ro'), 0o555);
    chmodSync(join(from, 'node_modules', 'exec-only'), 0o711);
    chmodSync(join(from, 'node_modules'), 0o750);
    const result = await seedWorktree({ from, to, dirs: ['node_modules'], signal });
    expect(result.files).toBe(2);
    expect(lstatSync(join(to, 'node_modules')).mode & 0o7777).toBe(0o750);
    expect(lstatSync(join(to, 'node_modules', 'ro')).mode & 0o7777).toBe(0o555);
    expect(lstatSync(join(to, 'node_modules', 'exec-only')).mode & 0o7777).toBe(0o711);
    expect(readFileSync(join(to, 'node_modules', 'ro', 'f'), 'utf8')).toBe('x');
  });

  it('copies a link as a link and never follows it', async () => {
    const dir = join(from, 'node_modules');
    mkdirSync(dir);
    symlinkSync('/etc', join(dir, 'absolute'));
    symlinkSync('sibling', join(dir, 'relative'));
    symlinkSync('/does/not/exist', join(dir, 'dangling'));
    const result = await seedWorktree({ from, to, dirs: ['node_modules'], signal });
    expect(result).toEqual({ files: 0, links: 3, skipped: [] });
    for (const [name, target] of [
      ['absolute', '/etc'],
      ['relative', 'sibling'],
      ['dangling', '/does/not/exist'],
    ]) {
      const copy = join(to, 'node_modules', name ?? '');
      expect(lstatSync(copy).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copy)).toBe(target);
    }
    // Following the link to /etc would have made a directory of this name.
    expect(existsSync(join(to, 'etc'))).toBe(false);
    expect(lstatSync(join(to, 'node_modules')).isDirectory()).toBe(true);
  });

  it('skips a FIFO and a socket and lists them', async () => {
    const dir = join(from, 'node_modules');
    mkdirSync(dir);
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(join(dir, 's'), resolve);
    });
    try {
      writeFileSync(join(dir, 'plain'), 'p');
      const result = await seedWorktree({ from, to, dirs: ['node_modules'], signal });
      expect(result.files).toBe(1);
      expect([...result.skipped].sort()).toEqual([join(dir, 'fifo'), join(dir, 's')].sort());
      expect(existsSync(join(to, 'node_modules', 'fifo'))).toBe(false);
      expect(existsSync(join(to, 'node_modules', 's'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('skips a seed dir whose parent is not in the worktree, and one whose parent is a link', async () => {
    mkdirSync(join(from, 'apps', 'web', 'node_modules'), { recursive: true });
    writeFileSync(join(from, 'apps', 'web', 'node_modules', 'a'), 'a');
    mkdirSync(join(from, 'tools', 'node_modules'), { recursive: true });
    mkdirSync(join(tmp.path, 'elsewhere'));
    symlinkSync(join(tmp.path, 'elsewhere'), join(to, 'tools'));
    const result = await seedWorktree({
      from,
      to,
      dirs: ['apps/web/node_modules', 'tools/node_modules'],
      signal,
    });
    expect(result).toEqual({
      files: 0,
      links: 0,
      skipped: ['apps/web/node_modules', 'tools/node_modules'],
    });
    expect(existsSync(join(to, 'apps'))).toBe(false);
    expect(existsSync(join(tmp.path, 'elsewhere', 'node_modules'))).toBe(false);
  });

  it('refuses a destination that already exists', async () => {
    mkdirSync(join(from, 'node_modules'));
    mkdirSync(join(to, 'node_modules'));
    await expect(seedWorktree({ from, to, dirs: ['node_modules'], signal })).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });

  it('refuses a file that already exists at the destination', async () => {
    writeFileSync(join(from, 'tool.bin'), 'new');
    writeFileSync(join(to, 'tool.bin'), 'old');
    await expect(seedWorktree({ from, to, dirs: ['tool.bin'], signal })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(readFileSync(join(to, 'tool.bin'), 'utf8')).toBe('old');
  });

  it.each([
    ['a file', 'file'],
    ['a directory', 'dir'],
  ])('fails the whole seed on an unreadable %s', async (_name, kind) => {
    const dir = join(from, 'node_modules');
    mkdirSync(dir);
    for (let i = 0; i < 40; i += 1) writeFileSync(join(dir, `ok-${String(i)}`), 'ok');
    if (kind === 'file') {
      writeFileSync(join(dir, 'locked'), 'secret');
      chmodSync(join(dir, 'locked'), 0o000);
    } else {
      mkdirSync(join(dir, 'locked'));
      chmodSync(join(dir, 'locked'), 0o000);
    }
    await expect(seedWorktree({ from, to, dirs: ['node_modules'], signal })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('stops before writing anything when the signal is already aborted', async () => {
    mkdirSync(join(from, 'node_modules'));
    writeFileSync(join(from, 'node_modules', 'f'), 'x');
    const reason = new Error('cut stopped');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      seedWorktree({ from, to, dirs: ['node_modules'], signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(existsSync(join(to, 'node_modules'))).toBe(false);
  });
});
