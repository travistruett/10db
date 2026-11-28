import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEPT_DIR_MODE, KeptCopyError, onlyHere, saveKept, sha256File } from './kept-files';

const MODE_BITS = 0o777;
const AT = new Date(Date.UTC(2026, 10, 27, 9, 5, 7));

let base: string;
let worktree: string;
let checkout: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'kept-files-'));
  worktree = join(base, 'worktree');
  checkout = join(base, 'checkout');
  root = join(base, 'kept');
  await mkdir(worktree);
  await mkdir(checkout);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function write(dir: string, file: string, text: string, mode?: number): Promise<void> {
  const path = join(dir, file);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  if (mode !== undefined) await chmod(path, mode);
}

async function modeOf(path: string): Promise<number> {
  return (await lstat(path)).mode & MODE_BITS;
}

describe('onlyHere', () => {
  it('drops an identical copy and a file a tool writes again, and keeps the rest', async () => {
    await write(worktree, '.env', 'same');
    await write(checkout, '.env', 'same');
    await write(worktree, 'local.json', 'new text');
    await write(checkout, 'local.json', 'old text');
    await write(worktree, 'notes.md', 'only here');
    await write(worktree, 'tsconfig.tsbuildinfo', 'rebuilt');
    await write(worktree, 'apps/web/next-env.d.ts', 'generated');
    await write(worktree, 'size.txt', 'abc');
    await write(checkout, 'size.txt', 'abcd');
    await symlink('target-a', join(worktree, 'same-link'));
    await symlink('target-a', join(checkout, 'same-link'));
    await symlink('target-a', join(worktree, 'other-link'));
    await symlink('target-b', join(checkout, 'other-link'));

    const kept = await onlyHere({
      worktree,
      checkout,
      files: [
        '.env',
        'local.json',
        'notes.md',
        'tsconfig.tsbuildinfo',
        'apps/web/next-env.d.ts',
        'size.txt',
        'same-link',
        'other-link',
      ],
    });

    expect(kept).toEqual(['local.json', 'notes.md', 'size.txt', 'other-link']);
  });
});

describe('saveKept', () => {
  it('copies each file into a 0700 folder with its content and mode, and saves a link as a link', async () => {
    await write(worktree, 'private.env', 'secret', 0o600);
    await write(worktree, 'tools/run.sh', '#!/bin/sh\n', 0o755);
    await symlink('private.env', join(worktree, 'alias'));
    // A folder an earlier run left wide open: the save narrows it.
    await mkdir(join(root, 'bat_1'), { recursive: true });
    await chmod(root, 0o755);
    await chmod(join(root, 'bat_1'), 0o755);

    const saved = await saveKept({
      root,
      name: 'bat_1',
      worktree,
      files: ['private.env', 'tools/run.sh', 'alias'],
      at: AT,
    });

    expect(saved.dir).toBe(join(root, 'bat_1', '20261127-090507'));
    expect(saved.saved).toEqual(['private.env', 'tools/run.sh', 'alias']);
    expect(KEPT_DIR_MODE).toBe(0o700);
    for (const folder of [root, join(root, 'bat_1'), saved.dir, join(saved.dir, 'tools')]) {
      expect.soft(await modeOf(folder), folder).toBe(KEPT_DIR_MODE);
    }
    expect(await readFile(join(saved.dir, 'private.env'), 'utf8')).toBe('secret');
    expect(await modeOf(join(saved.dir, 'private.env'))).toBe(0o600);
    expect(await readFile(join(saved.dir, 'tools/run.sh'), 'utf8')).toBe('#!/bin/sh\n');
    expect(await modeOf(join(saved.dir, 'tools/run.sh'))).toBe(0o755);
    expect((await lstat(join(saved.dir, 'alias'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(saved.dir, 'alias'))).toBe('private.env');
  });

  it('never writes into an earlier folder of the same name', async () => {
    await write(worktree, 'a.env', 'first');
    const first = await saveKept({ root, name: 'bat_1', worktree, files: ['a.env'], at: AT });
    await write(worktree, 'a.env', 'second');
    const second = await saveKept({ root, name: 'bat_1', worktree, files: ['a.env'], at: AT });

    expect(second.dir).not.toBe(first.dir);
    expect(await readFile(join(first.dir, 'a.env'), 'utf8')).toBe('first');
    expect(await readFile(join(second.dir, 'a.env'), 'utf8')).toBe('second');
  });

  it.each([
    { what: 'a relative path that climbs out', name: 'bat_1', file: '../outside.env' },
    { what: 'a climb hidden behind a folder', name: 'bat_1', file: 'a/../../outside.env' },
    { what: 'an absolute path', name: 'bat_1', file: '/etc/hosts' },
    { what: 'a name that climbs out', name: '../escape', file: 'a.env' },
    { what: 'a name with a separator', name: 'a/b', file: 'a.env' },
    { what: 'an empty name', name: '', file: 'a.env' },
  ])('refuses $what and copies nothing', async ({ name, file }) => {
    await write(worktree, 'a.env', 'x');
    await write(base, 'outside.env', 'outside');

    await expect(
      saveKept({ root, name, worktree, files: ['a.env', file], at: AT }),
    ).rejects.toThrow();

    await expect(lstat(join(root, 'bat_1'))).rejects.toThrow();
    await expect(lstat(join(base, 'escape'))).rejects.toThrow();
  });

  it('throws KeptCopyError naming the file when a source changes between the copy and the check', async () => {
    await write(worktree, 'a.env', 'before');

    const failure = await saveKept({
      root,
      name: 'bat_1',
      worktree,
      files: ['a.env'],
      at: AT,
      // The first read of the check finds the source rewritten at the same size.
      hash: async (path) => {
        if (path === join(worktree, 'a.env')) await writeFile(path, 'after!');
        return sha256File(path);
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KeptCopyError);
    expect(failure).toHaveProperty('file', 'a.env');
  });
});
