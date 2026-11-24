import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit, type FolderRead } from './index';

const git = createGit();
let repo: TempDir;
let built = false;
afterEach(() => {
  repo.cleanup();
  built = false;
});

const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
const write = (rel: string, text: string) => {
  writeFileSync(join(repo.path, rel), text);
};

/** A folder on `main` at T, and a commit C on `copy` that changes `a.txt` and adds `b.txt`. */
let T = '';
let C = '';
function folder(): void {
  if (built) repo.cleanup();
  built = true;
  repo = createTempRepo();
  write('a.txt', 'one\n');
  rawGit('add', 'a.txt');
  rawGit('commit', '-q', '-m', 'a');
  T = rawGit('rev-parse', 'HEAD');
  rawGit('switch', '-q', '-c', 'copy');
  write('a.txt', 'two\n');
  write('b.txt', 'new\n');
  // A link whose target is missing: git hashes the link text, a file read would fail.
  symlinkSync('no-such-target', join(repo.path, 'link'));
  rawGit('add', 'a.txt', 'b.txt', 'link');
  rawGit('commit', '-q', '-m', 'copy');
  C = rawGit('rev-parse', 'HEAD');
  rawGit('switch', '-q', 'main');
}
const input = () => ({ repo: repo.path, branch: 'main', expected: T, candidate: C });
const state = () => ({
  ref: rawGit('rev-parse', 'refs/heads/main'),
  index: rawGit('ls-files', '-s'),
  status: rawGit('status', '--porcelain', '--untracked-files=all'),
});

beforeEach(folder);

describe('promoteFastForward', () => {
  it('stops at an edit in a written path, ignores a touched file, puts the files back when the swap fails, then lands', async () => {
    write('a.txt', 'mine\n');
    let before = state();
    expect(await git.promoteFastForward(input())).toEqual({
      kind: 'in_the_way',
      changed: ['a.txt'],
      kept: [],
    });
    expect(state()).toEqual(before);
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('mine\n');
    write('a.txt', 'one\n');
    // Staged, then the file put back to HEAD: the index differs, the file doesn't.
    write('a.txt', 'staged\n');
    rawGit('add', 'a.txt');
    write('a.txt', 'one\n');
    before = state();
    expect(await git.promoteFastForward(input())).toEqual({
      kind: 'in_the_way',
      changed: ['a.txt'],
      kept: [],
    });
    expect(state()).toEqual(before);
    rawGit('add', 'a.txt');
    before = state();

    // A held ref lock fails only the swap: the ref is still T, so the files and index go back.
    writeFileSync(join(repo.path, '.git/refs/heads/main.lock'), '');
    expect(await git.promoteFastForward(input())).toEqual({ kind: 'base_moved', now: T });
    expect(state()).toEqual(before);
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('one\n');
    execFileSync('rm', [join(repo.path, '.git/refs/heads/main.lock')]);

    // Only the modification time changes: not an edit.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo.path, 'a.txt'), later, later);
    expect(await git.promoteFastForward(input())).toEqual({ kind: 'promoted' });
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(C);
    expect(readFileSync(join(repo.path, 'a.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(repo.path, 'b.txt'), 'utf8')).toBe('new\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
  });
});

describe('classifyFolder', () => {
  it('reads each row of the recovery table from a real folder', async () => {
    const rows: [string, () => void, FolderRead][] = [
      ['A', () => rawGit('switch', '-q', 'copy'), { row: 'A', head: 'copy' }],
      ['B', () => rawGit('merge', '-q', '--ff-only', 'copy'), { row: 'B' }],
      ['C', () => undefined, { row: 'C' }],
      ['D', () => rawGit('read-tree', '-m', '-u', T, C), { row: 'D' }],
      [
        'E',
        () => {
          write('c.txt', 'c\n');
          rawGit('add', 'c.txt');
          rawGit('commit', '-q', '-m', 'moved');
        },
        { row: 'E', now: '' },
      ],
      [
        'F',
        () => {
          write('a.txt', 'mine\n');
        },
        { row: 'F', paths: ['a.txt'] },
      ],
      [
        'G',
        () => {
          rawGit('read-tree', '-m', '-u', T, C);
          const moved = rawGit('commit-tree', `${T}^{tree}`, '-p', T, '-m', 'moved');
          rawGit('update-ref', 'refs/heads/main', moved);
        },
        { row: 'G', paths: ['a.txt', 'b.txt', 'link'], ref: '' },
      ],
      [
        'G, a half-written folder with an edit',
        () => {
          write('a.txt', 'two\n');
          write('b.txt', 'mine\n');
        },
        { row: 'G', paths: ['a.txt', 'b.txt'], ref: '' },
      ],
    ];
    for (const [name, build, want] of rows) {
      folder();
      build();
      const tip = rawGit('rev-parse', 'refs/heads/main');
      const expected =
        want.row === 'E' ? { ...want, now: tip } : want.row === 'G' ? { ...want, ref: tip } : want;
      const before = state();
      expect(await git.classifyFolder(input()), `row ${name}`).toEqual(expected);
      expect(state(), `row ${name} writes nothing`).toEqual(before);
    }

    // finishPromotion swaps only while C's files are all there: discarded since the read, it refuses.
    folder();
    rawGit('read-tree', '-m', '-u', T, C);
    rawGit('read-tree', '-m', '-u', C, T);
    expect(await git.finishPromotion(input())).toBe('raced');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(T);
    rawGit('read-tree', '-m', '-u', T, C);
    expect(await git.finishPromotion(input())).toBe('promoted');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(C);
  });
});
