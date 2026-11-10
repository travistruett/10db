import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from './index';

// Workbench spec §5.4: a take-out puts a page's files back, each hashed again just before it is
// written; a later pass merges kept work back three ways; an Abandon points HEAD home and refreshes
// the folder's index, all without a file written behind the builder's back.

const git = createGit();
let repo: TempDir;
let start: string;

beforeEach(() => {
  repo = createTempRepo();
  write('src/a.ts', 'a\n');
  write('src/b.ts', 'one\ntwo\nthree\nfour\nfive\n');
  write('src/run.sh', '#!/bin/sh\n');
  chmodSync(join(repo.path, 'src/run.sh'), 0o755);
  rawGit('add', '-A');
  rawGit('commit', '-q', '-m', 'Start');
  start = rawGit('rev-parse', 'HEAD');
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
const read = (rel: string) => readFileSync(join(repo.path, rel), 'utf8');
const blobOf = (rel: string) => rawGit('hash-object', rel);

describe('restoreFiles', () => {
  it('writes each file as its commit has it, removes one the commit lacks, and leaves one that changed since it was hashed', async () => {
    write('src/a.ts', 'a, by the task\n');
    write('src/new.ts', 'added by the task\n');
    write('src/b.ts', 'b, by the task\n');
    unlinkSync(join(repo.path, 'src/run.sh'));
    const expect_ = [
      { path: 'src/a.ts', blob: blobOf('src/a.ts') },
      { path: 'src/new.ts', blob: blobOf('src/new.ts') },
      { path: 'src/run.sh', blob: null },
      // Hashed, then written again before the restore reached it.
      { path: 'src/b.ts', blob: blobOf('src/b.ts') },
    ];
    write('src/b.ts', 'b, written again by the builder\n');

    const done = await git.restoreFiles(
      repo.path,
      ['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/run.sh'].map((path) => ({ path, from: start })),
      expect_,
    );

    expect(done).toEqual({ written: ['src/a.ts', 'src/new.ts', 'src/run.sh'], left: ['src/b.ts'] });
    expect(read('src/a.ts')).toBe('a\n');
    expect(existsSync(join(repo.path, 'src/new.ts'))).toBe(false);
    expect(read('src/run.sh')).toBe('#!/bin/sh\n');
    expect(statSync(join(repo.path, 'src/run.sh')).mode & 0o111).not.toBe(0);
    expect(read('src/b.ts')).toBe('b, written again by the builder\n');
    // Nothing but the files: HEAD and the folder's own index are as they were.
    expect(rawGit('rev-parse', 'HEAD')).toBe(start);
    expect(rawGit('diff', '--cached', '--name-only')).toBe('');
  });

  it('writes nothing twice: a file already as asked is done, whatever it was expected to hold', async () => {
    const done = await git.restoreFiles(
      repo.path,
      [{ path: 'src/a.ts', from: start }],
      [{ path: 'src/a.ts', blob: 'f'.repeat(40) }],
    );
    expect(done).toEqual({ written: ['src/a.ts'], left: [] });
  });
});

describe('mergeFileBack', () => {
  it('merges kept work into a file that changed since, three ways from the commit it was kept on', async () => {
    write('src/b.ts', 'one\ntwo, kept\nthree\nfour\nfive\n');
    rawGit('add', 'src/b.ts');
    rawGit('commit', '-q', '-m', 'Kept');
    const kept = rawGit('rev-parse', 'HEAD');
    rawGit('reset', '-q', '--hard', start);
    write('src/b.ts', 'one\ntwo\nthree\nfour\nfive, on disk\n');

    expect(
      await git.mergeFileBack({ repo: repo.path, path: 'src/b.ts', base: start, theirs: kept }),
    ).toBe('merged');
    expect(read('src/b.ts')).toBe('one\ntwo, kept\nthree\nfour\nfive, on disk\n');
  });

  it('leaves a file whose change does not merge as it is', async () => {
    write('src/b.ts', 'one\ntwo, kept\nthree\nfour\nfive\n');
    rawGit('add', 'src/b.ts');
    rawGit('commit', '-q', '-m', 'Kept');
    const kept = rawGit('rev-parse', 'HEAD');
    rawGit('reset', '-q', '--hard', start);
    write('src/b.ts', 'one\ntwo, on disk\nthree\nfour\nfive\n');

    expect(
      await git.mergeFileBack({ repo: repo.path, path: 'src/b.ts', base: start, theirs: kept }),
    ).toBe('conflict');
    expect(read('src/b.ts')).toBe('one\ntwo, on disk\nthree\nfour\nfive\n');
  });
});

describe('pointHeadAt', () => {
  it('points HEAD at the other branch only when both are at the commit, and writes no file', async () => {
    rawGit('branch', '10db/pass-abc123');
    rawGit('symbolic-ref', 'HEAD', 'refs/heads/10db/pass-abc123');
    write('src/a.ts', 'dirt\n');
    const point = () =>
      git.pointHeadAt({ repo: repo.path, from: '10db/pass-abc123', to: 'main', sha: start });

    expect(await point()).toBe(true);
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(read('src/a.ts')).toBe('dirt\n');

    // A branch that moved, or a HEAD on neither, is left as it is.
    rawGit('symbolic-ref', 'HEAD', 'refs/heads/10db/pass-abc123');
    rawGit(
      'update-ref',
      'refs/heads/main',
      rawGit('commit-tree', '-p', start, '-m', 'x', `${start}^{tree}`),
    );
    expect(await point()).toBe(false);
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/10db/pass-abc123');
  });
});

describe('refreshIndex', () => {
  it("refreshes the folder's own index for a file 10db put back as it was", async () => {
    const indexed = () => /mtime: (\d+):/.exec(rawGit('ls-files', '--debug', 'src/a.ts'))?.[1];
    // Put back with the same bytes and a later time, as a restore writes it.
    write('src/a.ts', 'a\n');
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(repo.path, 'src/a.ts'), later, later);
    expect(indexed()).not.toBe(String(Math.floor(later.getTime() / 1000)));

    expect(await git.refreshIndex(repo.path, ['src/a.ts'])).toBe(true);
    expect(indexed()).toBe(String(Math.floor(later.getTime() / 1000)));
  });
});
