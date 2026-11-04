import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from './index';

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
  rawGit('switch', '-q', '-c', 'work');
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

/** Commits `files` on the checked-out branch with the builder's own git; returns the SHA. */
function commitFiles(files: Record<string, string>, message: string): string {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(repo.path, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  rawGit('add', '--', ...Object.keys(files));
  rawGit('commit', '-q', '-m', message);
  return rawGit('rev-parse', 'HEAD');
}

const revert = (shas: string[]) =>
  git.revertCommits({
    repo: repo.path,
    branch: 'work',
    shas,
    message: 'revert: leave out "Alpha"',
  });

describe('revertCommits', () => {
  it('reverts the named commits in one commit on the branch, keeping the others and the files in step', async () => {
    const first = commitFiles({ 'src/alpha-1.txt': 'one\n' }, 'alpha 1');
    commitFiles({ 'src/beta.txt': 'beta\n' }, 'beta');
    const second = commitFiles({ 'src/alpha-2.txt': 'two\n' }, 'alpha 2');
    const before = rawGit('rev-parse', 'HEAD');

    const result = await revert([first, second]);

    expect(result.kind).toBe('reverted');
    const head = rawGit('rev-parse', 'HEAD');
    expect(result).toMatchObject({
      kind: 'reverted',
      head,
      paths: ['src/alpha-1.txt', 'src/alpha-2.txt'],
    });
    expect(rawGit('rev-list', '--count', `${before}..HEAD`)).toBe('1');
    expect(rawGit('rev-parse', 'HEAD^')).toBe(before);
    expect(rawGit('log', '-1', '--format=%s')).toBe('revert: leave out "Alpha"');
    expect(existsSync(join(repo.path, 'src/alpha-1.txt'))).toBe(false);
    expect(existsSync(join(repo.path, 'src/alpha-2.txt'))).toBe(false);
    expect(readFileSync(join(repo.path, 'src/beta.txt'), 'utf8')).toBe('beta\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('writes nothing and names the files when a later commit built on what it reverts', async () => {
    const alpha = commitFiles({ 'src/shared.txt': 'alpha\n' }, 'alpha');
    commitFiles({ 'src/shared.txt': 'alpha\nbeta\n' }, 'beta builds on alpha');
    const before = rawGit('rev-parse', 'HEAD');

    expect(await revert([alpha])).toEqual({ kind: 'conflict', paths: ['src/shared.txt'] });
    expect(rawGit('rev-parse', 'HEAD')).toBe(before);
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(before);
    expect(readFileSync(join(repo.path, 'src/shared.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('writes nothing when an uncommitted change is in a file the revert writes', async () => {
    const alpha = commitFiles({ 'src/alpha.txt': 'alpha\n' }, 'alpha');
    const before = rawGit('rev-parse', 'HEAD');
    writeFileSync(join(repo.path, 'src/alpha.txt'), 'edited\n');

    expect(await revert([alpha])).toEqual({
      kind: 'blocked',
      changed: ['src/alpha.txt'],
    });
    expect(rawGit('rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(repo.path, 'src/alpha.txt'), 'utf8')).toBe('edited\n');
  });

  it('reports nothing to revert when the commits changed nothing the branch still has', async () => {
    const alpha = commitFiles({ 'src/alpha.txt': 'alpha\n' }, 'alpha');
    rawGit('rm', '-q', 'src/alpha.txt');
    rawGit('commit', '-q', '-m', 'remove alpha');
    const before = rawGit('rev-parse', 'HEAD');

    expect(await revert([alpha])).toEqual({ kind: 'nothing' });
    expect(rawGit('rev-parse', 'HEAD')).toBe(before);
  });

  it('writes nothing and names the files when undoing a commit would bring conflict markers back', async () => {
    const marked = '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n';
    commitFiles({ 'src/merged.txt': marked }, 'the base merge left markers');
    const resolved = commitFiles({ 'src/merged.txt': 'a\nb\n' }, 'resolve the markers');
    const before = rawGit('rev-parse', 'HEAD');

    expect(await revert([resolved])).toEqual({ kind: 'markers', paths: ['src/merged.txt'] });
    expect(rawGit('rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(repo.path, 'src/merged.txt'), 'utf8')).toBe('a\nb\n');
  });

  it('reverts a commit in a file that held markers before it and still does', async () => {
    const marked = '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n';
    commitFiles({ 'src/fixture.txt': marked }, 'a fixture that shows a conflict');
    const edit = commitFiles({ 'src/fixture.txt': `${marked}more\n` }, 'alpha edits it');

    expect(await revert([edit])).toMatchObject({ kind: 'reverted', paths: ['src/fixture.txt'] });
    expect(readFileSync(join(repo.path, 'src/fixture.txt'), 'utf8')).toBe(marked);
  });

  it('refuses a branch the checkout is not on, and a commit that is not on the branch', async () => {
    const alpha = commitFiles({ 'src/alpha.txt': 'alpha\n' }, 'alpha');
    await expect(
      git.revertCommits({ repo: repo.path, branch: 'main', shas: [alpha], message: 'x' }),
    ).rejects.toThrow(InvalidError);
    await expect(revert(['0'.repeat(40)])).rejects.toThrow(InvalidError);
  });
});
