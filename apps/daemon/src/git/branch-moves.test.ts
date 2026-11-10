import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
