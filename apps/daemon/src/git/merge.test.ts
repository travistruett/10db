import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, tempDir, type TempDir } from '../../test/fixtures';
import { isolatedGitEnv } from '../../test/fixtures';
import { createGit, GitTrustError } from './index';

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
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

const write = (rel: string, text: string) => {
  const file = join(repo.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (rel: string) => readFileSync(join(repo.path, rel), 'utf8');

/**
 * Commits `files` on the checked-out branch with the builder's own git; returns the SHA. `force` adds
 * files the ignore rules match, as `git add -f` does.
 */
function commitFiles(files: Record<string, string>, message: string, force = false): string {
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  rawGit('add', ...(force ? ['-f'] : []), '--', ...Object.keys(files));
  rawGit('commit', '-q', '-m', message);
  return rawGit('rev-parse', 'HEAD');
}

/** Commits `files` on main while the checkout stays on `work`, as a teammate's merged PR would. */
function onMain(files: Record<string, string>, message: string, force = false): string {
  rawGit('switch', '-q', 'main');
  const sha = commitFiles(files, message, force);
  rawGit('switch', '-q', 'work');
  return sha;
}

/** What a merge must leave alone when it writes nothing. */
function snapshot() {
  return {
    head: rawGit('rev-parse', 'HEAD'),
    branch: rawGit('rev-parse', 'refs/heads/work'),
    index: rawGit('ls-files', '-s'),
    status: rawGit('status', '--porcelain', '--untracked-files=all'),
  };
}

const merge = () =>
  git.mergeIntoBranch({
    repo: repo.path,
    branch: 'work',
    from: 'main',
    message: 'Merge main into work',
  });

describe('mergeIntoBranch', () => {
  beforeEach(() => {
    rawGit('switch', '-q', '-c', 'work');
  });

  it('merges a base that moved on: a merge commit with the branch first, both sides in the files, nothing uncommitted', async () => {
    const own = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const base = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    const merged = await merge();
    expect(merged).toEqual({
      kind: 'merged',
      from: base,
      head: rawGit('rev-parse', 'HEAD'),
      fastForward: false,
      paths: ['src/theirs.txt'],
    });
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(merged.kind === 'merged' && merged.head);
    expect(rawGit('log', '-1', '--format=%P')).toBe(`${own} ${base}`);
    expect(rawGit('log', '-1', '--format=%s')).toBe('Merge main into work');
    expect(rawGit('branch', '--show-current')).toBe('work');
    expect(read('src/own.txt')).toBe('own\n');
    expect(read('src/theirs.txt')).toBe('theirs\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('fast-forwards a branch with nothing of its own', async () => {
    const base = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    expect(await merge()).toEqual({
      kind: 'merged',
      from: base,
      head: base,
      fastForward: true,
      paths: ['src/theirs.txt'],
    });
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(base);
    expect(read('src/theirs.txt')).toBe('theirs\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('is up to date when the branch already holds the base, and moves nothing', async () => {
    const base = rawGit('rev-parse', 'main');
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const before = snapshot();
    expect(await merge()).toEqual({ kind: 'up_to_date', from: base });
    expect(snapshot()).toEqual(before);
  });

  it('leaves the branch, index and files as they were on a conflict, naming the conflicted files', async () => {
    commitFiles({ 'README.md': '# ours\n', 'src/own.txt': 'own\n' }, 'own');
    const base = onMain({ 'README.md': '# theirs\n', 'src/theirs.txt': 'theirs\n' }, 'theirs');
    const before = snapshot();
    expect(await merge()).toEqual({ kind: 'conflict', from: base, paths: ['README.md'] });
    expect(snapshot()).toEqual(before);
    expect(read('README.md')).toBe('# ours\n');
    expect(existsSync(join(repo.path, 'src/theirs.txt'))).toBe(false);
  });

  it.each([
    ['an uncommitted change to a file the base changed', 'README.md'],
    ['an untracked file where the base adds one', 'src/theirs.txt'],
  ])('writes nothing when %s is in the way, naming it', async (_case, rel) => {
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const base = onMain({ 'README.md': '# theirs\n', 'src/theirs.txt': 'theirs\n' }, 'theirs');
    write(rel, 'a lane is still writing this\n');
    const before = snapshot();
    expect(await merge()).toEqual({ kind: 'blocked', from: base, paths: [rel] });
    expect(snapshot()).toEqual(before);
    expect(read(rel)).toBe('a lane is still writing this\n');
  });

  describe('ignored files, which read-tree would overwrite or delete', () => {
    it.each([
      {
        name: 'an ignored file where the base commits one',
        base: { 'secret.env': 'theirs\n' },
        ignored: ['secret.env'],
        blocked: ['secret.env'],
      },
      {
        name: 'an ignored directory where the base commits a file of that name',
        base: { build: 'a file now\n' },
        ignored: ['build/out.js'],
        blocked: ['build/'],
      },
      {
        name: 'an ignored file where the base commits a directory of that name',
        base: { 'cache/kept.txt': 'theirs\n' },
        ignored: ['cache'],
        blocked: ['cache'],
      },
    ])('writes nothing with $name in the way, naming it', async ({ base, ignored, blocked }) => {
      onMain({ '.gitignore': 'secret.env\nbuild/\ncache\n' }, 'ignore rules');
      rawGit('merge', '-q', '--ff-only', 'main');
      commitFiles({ 'src/own.txt': 'own\n' }, 'own');
      const from = onMain(base, 'theirs', true);
      for (const rel of ignored) write(rel, 'the builder keeps this\n');
      const before = snapshot();
      expect(await merge()).toEqual({ kind: 'blocked', from, paths: blocked });
      expect(snapshot()).toEqual(before);
      for (const rel of ignored) expect(read(rel)).toBe('the builder keeps this\n');
    });

    it('merges past an ignored file the base leaves alone, and keeps it', async () => {
      onMain({ '.gitignore': 'notes.local\n' }, 'ignore rules');
      rawGit('merge', '-q', '--ff-only', 'main');
      commitFiles({ 'src/own.txt': 'own\n' }, 'own');
      onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
      write('notes.local', 'kept\n');
      expect((await merge()).kind).toBe('merged');
      expect(read('notes.local')).toBe('kept\n');
    });
  });

  it('keeps uncommitted changes in files the base did not change', async () => {
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    write('src/own.txt', 'still being edited\n');
    write('src/new.txt', 'not committed yet\n');
    expect((await merge()).kind).toBe('merged');
    expect(read('src/own.txt')).toBe('still being edited\n');
    expect(read('src/new.txt')).toBe('not committed yet\n');
    expect(await git.changedPaths(repo.path)).toEqual(['src/new.txt', 'src/own.txt']);
  });

  it('runs no merge driver that attributes and config name, on either side', async () => {
    const scratch = tempDir('merge-driver');
    try {
      const marker = join(scratch.path, 'driver-ran');
      rawGit('config', 'merge.probe.driver', `touch '${marker}'; false`);
      // Both sides change the same file in lines far apart, so git merges it as text.
      const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`);
      rawGit('switch', '-q', 'main');
      commitFiles(
        { '.gitattributes': '* merge=probe\n', 'notes.txt': `${lines.join('\n')}\n` },
        'a',
      );
      rawGit('switch', '-q', 'work');
      rawGit('merge', '-q', '--ff-only', 'main');
      commitFiles({ 'notes.txt': `${['ours', ...lines.slice(1)].join('\n')}\n` }, 'ours');
      onMain({ 'notes.txt': `${[...lines.slice(0, -1), 'theirs'].join('\n')}\n` }, 'theirs');
      expect((await merge()).kind).toBe('merged');
      expect(existsSync(marker)).toBe(false);
      expect(read('notes.txt')).toBe(`${['ours', ...lines.slice(1, -1), 'theirs'].join('\n')}\n`);
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a base whose tree asks for a filter, writing nothing', async () => {
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    onMain({ '.gitattributes': '*.bin filter=lfs\n' }, 'lfs');
    const before = snapshot();
    const error: unknown = await merge().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustError);
    expect(error instanceof GitTrustError && error.detail).toEqual({
      kind: 'filter',
      paths: [{ path: '.gitattributes', filter: 'lfs' }],
    });
    expect(snapshot()).toEqual(before);
  });

  it('refuses a checkout that is not on the branch', async () => {
    onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    rawGit('switch', '-q', 'main');
    await expect(merge()).rejects.toBeInstanceOf(InvalidError);
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(rawGit('rev-parse', 'main~1'));
  });
});

describe('commitsSince after a merge', () => {
  it("lists the branch's own commits since a base, not the commits the merge brought in", async () => {
    rawGit('switch', '-q', '-c', 'work');
    const start = rawGit('rev-parse', 'HEAD');
    const own = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    onMain({ 'src/a.txt': 'a\n' }, 'a');
    onMain({ 'src/b.txt': 'b\n' }, 'b');
    const merged = await merge();
    if (merged.kind !== 'merged') throw new Error(`expected a merge, got ${merged.kind}`);
    expect(await git.commitsSince(repo.path, start)).toEqual([own, merged.head]);
    expect(await git.commitsSince(repo.path, merged.from)).toEqual([own, merged.head]);
  });
});

describe('a retried commit after a merge', () => {
  it('is not mistaken for a commit on the base that carries the same operation id', async () => {
    rawGit('switch', '-q', '-c', 'work');
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    // A squash-merged pull request keeps the 10db-Op trailers of the lane commits it folds in.
    rawGit('switch', '-q', 'main');
    write('src/theirs.txt', 'theirs\n');
    rawGit('add', '--', 'src/theirs.txt');
    rawGit('commit', '-q', '-m', 'theirs', '--trailer', '10db-Op: op-merged-1');
    rawGit('switch', '-q', 'work');
    expect((await merge()).kind).toBe('merged');
    write('src/next.txt', 'next\n');
    const next = await git.commit({
      repo: repo.path,
      paths: ['src/next.txt'],
      message: 'next',
      opId: 'op-merged-1',
      branch: 'work',
    });
    expect(next.alreadyCommitted).toBe(false);
    expect(rawGit('log', '-1', '--format=%s', 'work')).toBe('next');
  });
});

describe('mergedCommit', () => {
  beforeEach(() => {
    rawGit('switch', '-q', '-c', 'work');
  });
  const mergedCommit = (ours: string, theirs: string, ref = 'refs/10db/starts/ws-1') =>
    git.mergedCommit({ repo: repo.path, ours, theirs, ref, message: 'where it starts' });

  it('records the merge of two commits at a 10db ref, touching no file, index or branch', async () => {
    const ours = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const theirs = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    const before = snapshot();
    const made = await mergedCommit(ours, theirs);
    expect(made).toMatch(/^[0-9a-f]{40}$/);
    expect(rawGit('log', '-1', '--format=%P', made ?? '')).toBe(`${ours} ${theirs}`);
    expect(rawGit('rev-parse', 'refs/10db/starts/ws-1')).toBe(made);
    expect(rawGit('ls-tree', '-r', '--name-only', made ?? '').split('\n')).toEqual([
      'README.md',
      'src/own.txt',
      'src/theirs.txt',
    ]);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(repo.path, 'src/theirs.txt'))).toBe(false);
  });

  it.each([
    { name: 'theirs when ours is its ancestor', pick: 'theirs' },
    { name: 'ours when ours already holds theirs', pick: 'ours' },
  ])('answers $name, recording nothing', async ({ pick }) => {
    const older = rawGit('rev-parse', 'HEAD');
    const newer = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const made =
      pick === 'theirs' ? await mergedCommit(older, newer) : await mergedCommit(newer, older);
    expect(made).toBe(newer);
    expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/10db/starts/ws-1')).toThrow();
  });

  it('answers null on a conflict, recording nothing', async () => {
    const ours = commitFiles({ 'README.md': '# ours\n' }, 'own');
    const theirs = onMain({ 'README.md': '# theirs\n' }, 'theirs');
    expect(await mergedCommit(ours, theirs)).toBeNull();
    expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/10db/starts/ws-1')).toThrow();
  });

  it('refuses a ref outside refs/10db/', async () => {
    const ours = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const theirs = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    await expect(mergedCommit(ours, theirs, 'refs/heads/main')).rejects.toBeInstanceOf(
      InvalidError,
    );
    expect(rawGit('rev-parse', 'main')).toBe(theirs);
  });
});

describe('blobAt and isAncestor', () => {
  it('names the blob of a file in a commit, and null for a path that holds none', async () => {
    const head = rawGit('rev-parse', 'HEAD');
    expect(await git.blobAt(repo.path, head, 'README.md')).toBe(
      rawGit('rev-parse', `${head}:README.md`),
    );
    expect(await git.blobAt(repo.path, head, 'pnpm-lock.yaml')).toBeNull();
  });

  it('tells whether one commit is in the history of another', async () => {
    const older = rawGit('rev-parse', 'HEAD');
    const newer = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    expect(await git.isAncestor(repo.path, older, newer)).toBe(true);
    expect(await git.isAncestor(repo.path, newer, older)).toBe(false);
  });
});
