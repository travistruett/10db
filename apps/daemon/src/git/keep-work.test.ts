import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit, KeptRefMovedError, PassFolderOffBranchError } from './index';

// Workbench spec §9.1: a turn's work is kept as an unsigned commit at a ref, built from the pass's
// branch tip plus the task's page files as they are on disk; the branch does not move.

const git = createGit();
const BRANCH = '10db/polish-abc123';
const REF = 'refs/10db/passes/pas_1/tsk_1';
let repo: TempDir;
let tip: string;

beforeEach(() => {
  repo = createTempRepo();
  write('.gitignore', 'dist/\n');
  write('src/settings/page.tsx', 'settings\n');
  write('src/settings/old.tsx', 'old\n');
  write('src/people/page.tsx', 'people\n');
  rawGit('add', '-A');
  rawGit('commit', '-q', '-m', 'Pages');
  rawGit('switch', '-q', '-c', BRANCH);
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

const keep = (paths: readonly string[], parent: string | null, turn = 'ptn_1') =>
  git.keepWork({
    repo: repo.path,
    branch: BRANCH,
    ref: REF,
    paths,
    parent,
    message: 'Kept work of Settings',
    trailer: { key: '10db-turn', value: turn },
  });

const filesOf = (rev: string) => rawGit('ls-tree', '-r', '--name-only', rev).split('\n');

describe('keepWork', () => {
  it("keeps the named files as the folder has them, untracked and deleted included, and nothing of a neighbour's", async () => {
    write('src/settings/page.tsx', 'settings, edited\n');
    write('src/settings/new.tsx', 'untracked\n');
    unlinkSync(join(repo.path, 'src/settings/old.tsx'));
    write('src/people/page.tsx', "a neighbour's edit\n");
    write('dist/out.js', 'ignored\n');
    const index = readFileSync(join(repo.path, '.git/index'));
    const status = rawGit('status', '--porcelain');

    const kept = await keep(
      ['src/settings/page.tsx', 'src/settings/new.tsx', 'src/settings/old.tsx', 'dist/out.js'],
      null,
    );

    expect(kept).toMatchObject({ base: tip, made: true });
    expect(rawGit('rev-parse', REF)).toBe(kept.sha);
    // The first kept commit sits on the tip, holds the task's files and nothing else changed.
    expect(rawGit('rev-parse', `${REF}^`)).toBe(tip);
    expect(rawGit('diff', '--name-status', tip, REF)).toBe(
      ['A\tsrc/settings/new.tsx', 'D\tsrc/settings/old.tsx', 'M\tsrc/settings/page.tsx'].join('\n'),
    );
    expect(rawGit('show', `${REF}:src/settings/page.tsx`)).toBe('settings, edited');
    expect(rawGit('show', `${REF}:src/people/page.tsx`)).toBe('people');
    expect(filesOf(REF)).not.toContain('dist/out.js');
    // Unsigned, and trailered with the turn.
    expect(rawGit('log', '-1', '--format=%G?%n%(trailers:key=10db-turn,valueonly)', REF)).toBe(
      'N\nptn_1',
    );
    // The branch, HEAD, the folder's own index and what git status says are untouched.
    expect(rawGit('rev-parse', BRANCH)).toBe(tip);
    expect(rawGit('symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
    expect(readFileSync(join(repo.path, '.git/index')).equals(index)).toBe(true);
    expect(rawGit('status', '--porcelain')).toBe(status);
  });

  it('makes no commit when nothing changed: none at all before the first, the parent after it', async () => {
    expect(await keep(['src/settings/page.tsx'], null)).toEqual({
      sha: null,
      base: tip,
      made: false,
    });
    expect(rawGit('for-each-ref', 'refs/10db/')).toBe('');

    write('src/settings/page.tsx', 'edited\n');
    const first = await keep(['src/settings/page.tsx'], null);
    const again = await keep(['src/settings/page.tsx'], first.sha, 'ptn_2');
    expect(again).toEqual({ sha: first.sha, base: tip, made: false });
    expect(rawGit('rev-parse', REF)).toBe(first.sha);
  });

  it('chains each kept commit on the one before', async () => {
    write('src/settings/page.tsx', 'turn one\n');
    const first = await keep(['src/settings/page.tsx'], null);
    write('src/settings/page.tsx', 'turn two\n');
    const second = await keep(['src/settings/page.tsx'], first.sha, 'ptn_2');
    expect(second.made).toBe(true);
    expect(rawGit('rev-parse', `${REF}^`)).toBe(first.sha);
    expect(rawGit('show', `${REF}:src/settings/page.tsx`)).toBe('turn two');
  });

  it('finds the commit it made on a rerun of the same turn, whatever the folder holds now', async () => {
    write('src/settings/page.tsx', 'turn one\n');
    const first = await keep(['src/settings/page.tsx'], null);
    write('src/settings/page.tsx', 'edited after\n');
    expect(await keep(['src/settings/page.tsx'], null)).toEqual({
      sha: first.sha,
      base: tip,
      made: false,
    });
    expect(rawGit('rev-parse', REF)).toBe(first.sha);
  });

  it('moves the ref only from the parent it was given', async () => {
    write('src/settings/page.tsx', 'turn one\n');
    const first = await keep(['src/settings/page.tsx'], null);
    write('src/settings/page.tsx', 'turn two\n');
    await expect(keep(['src/settings/page.tsx'], null, 'ptn_2')).rejects.toThrow(KeptRefMovedError);
    expect(rawGit('rev-parse', REF)).toBe(first.sha);
  });

  it('is refused while HEAD is not the pass branch, and writes nothing', async () => {
    rawGit('switch', '-q', 'main');
    write('src/settings/page.tsx', 'edited\n');
    await expect(keep(['src/settings/page.tsx'], null)).rejects.toThrow(PassFolderOffBranchError);
    expect(rawGit('for-each-ref', 'refs/10db/')).toBe('');
  });
});

describe('pageChanges', () => {
  it('counts lines added and removed against the tip for each changed file, untracked and deleted included', async () => {
    write('src/settings/page.tsx', 'settings\nline two\nline three\n');
    write('src/settings/new.tsx', 'one\ntwo\n');
    unlinkSync(join(repo.path, 'src/settings/old.tsx'));
    write('src/people/page.tsx', 'not asked about\n');

    expect(
      await git.pageChanges(repo.path, tip, [
        'src/settings/page.tsx',
        'src/settings/new.tsx',
        'src/settings/old.tsx',
        'src/settings/unchanged-and-missing.tsx',
      ]),
    ).toEqual([
      { path: 'src/settings/new.tsx', added: 2, removed: 0 },
      { path: 'src/settings/old.tsx', added: 0, removed: 1 },
      { path: 'src/settings/page.tsx', added: 2, removed: 0 },
    ]);
  });
});

describe('hashOnDisk', () => {
  it("names each file's blob as the folder holds it, null for one that is not there", async () => {
    write('src/settings/page.tsx', 'edited\n');
    write('src/settings/new.tsx', 'untracked\n');
    unlinkSync(join(repo.path, 'src/settings/old.tsx'));
    const status = rawGit('status', '--porcelain');
    const index = readFileSync(join(repo.path, '.git/index'));

    expect(
      await git.hashOnDisk(repo.path, [
        'src/settings/page.tsx',
        'src/settings/new.tsx',
        'src/settings/old.tsx',
        'src/people/page.tsx',
      ]),
    ).toEqual([
      { path: 'src/people/page.tsx', blob: rawGit('hash-object', 'src/people/page.tsx') },
      { path: 'src/settings/new.tsx', blob: rawGit('hash-object', 'src/settings/new.tsx') },
      { path: 'src/settings/old.tsx', blob: null },
      { path: 'src/settings/page.tsx', blob: rawGit('hash-object', 'src/settings/page.tsx') },
    ]);
    // Reading writes nothing the builder's git would see.
    expect(rawGit('status', '--porcelain')).toBe(status);
    expect(readFileSync(join(repo.path, '.git/index')).equals(index)).toBe(true);
  });
});
