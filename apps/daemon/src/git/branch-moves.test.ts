import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from './index';

// Workbench spec §5.3, §5.4 (D8, D22): a closed pass's return branch is moved by compare-and-swap
// only, so a branch someone moved since is never forced, and a rerun after a crash changes nothing.

const git = createGit();
let repo: TempDir;
let start: string;
let tip: string;

beforeEach(() => {
  repo = createTempRepo();
  write('src/a.ts', 'a\n');
  rawGit('add', '-A');
  rawGit('commit', '-q', '-m', 'Start');
  start = rawGit('rev-parse', 'HEAD');
  rawGit('switch', '-q', '-c', '10db/pass-abc123');
  write('src/a.ts', 'signed off\n');
  rawGit('commit', '-q', '-am', 'Signed off');
  tip = rawGit('rev-parse', 'HEAD');
});
afterEach(() => {
  repo.cleanup();
});

const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

function write(rel: string, text: string): void {
  const file = join(repo.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('moveBranchCas', () => {
  const move = (expect: string) =>
    git.moveBranchCas({ repo: repo.path, branch: 'main', to: tip, expect });

  it('moves the branch from where it was expected, then answers already on a rerun', async () => {
    expect(await move(start)).toBe('moved');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
    expect(await move(start)).toBe('already');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
  });

  it('answers raced and moves nothing when the branch is no longer where it was expected', async () => {
    const other = rawGit('commit-tree', '-p', start, '-m', 'own', `${start}^{tree}`);
    rawGit('update-ref', 'refs/heads/main', other);

    expect(await move(start)).toBe('raced');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(other);
  });

  it('answers raced for a branch that is not there', async () => {
    expect(
      await git.moveBranchCas({ repo: repo.path, branch: 'gone', to: tip, expect: start }),
    ).toBe('raced');
  });

  it('moves the branch HEAD names when the trees match, writing no file', async () => {
    rawGit('switch', '-q', 'main');
    const same = rawGit('commit-tree', '-p', start, '-m', 'squash', `${start}^{tree}`);
    write('src/a.ts', 'dirt\n');

    expect(
      await git.moveBranchCas({ repo: repo.path, branch: 'main', to: same, expect: start }),
    ).toBe('moved');
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(readFileSync(join(repo.path, 'src/a.ts'), 'utf8')).toBe('dirt\n');
  });

  it('refuses to move a checked-out branch to a commit with other files', async () => {
    rawGit('switch', '-q', 'main');

    await expect(move(start)).rejects.toThrow(/checked out/);
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(start);
  });
});

describe('moveCheckedOutBranch', () => {
  /** The base as a squash merge left it: the pass's change fixed by CI, and another pull request's file. */
  function squashedBase(): string {
    rawGit('switch', '-q', 'main');
    rawGit('merge', '-q', '--ff-only', tip);
    write('src/b.ts', 'another pull request\n');
    write('src/a.ts', 'signed off, then fixed by CI\n');
    rawGit('add', 'src/a.ts', 'src/b.ts');
    const tree = rawGit('write-tree');
    rawGit('reset', '-q', '--hard');
    return rawGit('commit-tree', '-p', start, '-m', 'squash', tree);
  }
  const move = (to: string) =>
    git.moveCheckedOutBranch({ repo: repo.path, branch: 'main', from: tip, to });

  it("moves the branch HEAD names and its files to the commit, keeping changes the move doesn't write", async () => {
    const base = squashedBase();
    write('notes.md', 'mine\n');

    expect(await move(base)).toEqual({ kind: 'switched' });
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(base);
    expect(readFileSync(join(repo.path, 'src/b.ts'), 'utf8')).toBe('another pull request\n');
    expect(readFileSync(join(repo.path, 'notes.md'), 'utf8')).toBe('mine\n');
    expect(rawGit('status', '--porcelain')).toBe('?? notes.md');
  });

  it('refuses, naming them, when uncommitted changes lie where the move writes', async () => {
    const base = squashedBase();
    write('src/a.ts', 'edited\n');

    expect(await move(base)).toEqual({ kind: 'dirty', paths: ['src/a.ts'] });
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
    expect(readFileSync(join(repo.path, 'src/a.ts'), 'utf8')).toBe('edited\n');
  });

  it('finishes a move a crash cut short between the files and the branch', async () => {
    const base = squashedBase();
    // What the move had written when the daemon died: the files and the index, not the branch.
    rawGit('read-tree', '-m', '-u', tip, base);

    expect(await move(base)).toEqual({ kind: 'switched' });
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(base);
    expect(rawGit('status', '--porcelain')).toBe('');
  });

  it('refuses a branch HEAD does not name, or one that moved', async () => {
    const base = squashedBase();
    rawGit('switch', '-q', '10db/pass-abc123');
    expect(await move(base)).toEqual({ kind: 'moved', found: '10db/pass-abc123' });
    rawGit('switch', '-q', 'main');
    rawGit('commit', '-q', '--allow-empty', '-m', 'own');
    expect(await move(base)).toEqual({ kind: 'moved', found: 'main' });
  });
});

describe('mergeKeepingTree', () => {
  it("brings a commit into the branch by one merge commit whose tree is the branch's own, once", async () => {
    // The base took the pass's work by a squash: same tree, other history.
    const squash = rawGit('commit-tree', '-p', start, '-m', 'squash', `${tip}^{tree}`);
    rawGit('update-ref', 'refs/heads/main', squash);
    write('notes.md', 'mine\n');
    const merge = () =>
      git.mergeKeepingTree({
        repo: repo.path,
        branch: '10db/pass-abc123',
        theirs: squash,
        message: 'Merge main',
      });

    const made = await merge();
    expect(made.kind).toBe('merged');
    const head = rawGit('rev-parse', 'refs/heads/10db/pass-abc123');
    expect(head).toBe(made.sha);
    expect(rawGit('rev-parse', `${head}^1`, `${head}^2`)).toBe(`${tip}\n${squash}`);
    expect(rawGit('rev-parse', `${head}^{tree}`)).toBe(rawGit('rev-parse', `${tip}^{tree}`));
    expect(rawGit('status', '--porcelain')).toBe('?? notes.md');

    expect(await merge()).toEqual({ kind: 'already', sha: head });
    expect(rawGit('rev-parse', 'refs/heads/10db/pass-abc123')).toBe(head);
  });
});

describe('branchInUseElsewhere', () => {
  it('names a worktree that has the branch, and passes over the checkout itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elsewhere-'));
    try {
      rawGit('branch', 'side', start);
      const path = join(root, 'side');
      rawGit('worktree', 'add', '-q', path, 'side');

      expect(await git.branchInUseElsewhere(repo.path, 'side')).toBe(realpathSync(path));
      expect(await git.branchInUseElsewhere(repo.path, '10db/pass-abc123')).toBeNull();
      rawGit('worktree', 'remove', '--force', path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
