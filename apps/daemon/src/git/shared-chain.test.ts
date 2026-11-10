import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit, KeptRefMovedError, PassFolderOffBranchError } from './index';

// Workbench spec §7.2: a shared hold's record is an unsigned commit of the folder's content, and the
// pass's shared chain moves by compare-and-swap, one unsigned commit per change, never an empty one.

const git = createGit();
const CHAIN = 'refs/10db/passes/pas_1/shared';
let repo: TempDir;
let start: string;

beforeEach(() => {
  repo = createTempRepo();
  write('src/shared.ts', 'shared\n');
  write('src/button.ts', 'button\n');
  rawGit('add', '-A');
  rawGit('commit', '-q', '-m', 'Shared');
  rawGit('switch', '-q', '-c', '10db/polish');
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

const hash = (text: string) =>
  execFileSync('git', ['hash-object', '--stdin'], { input: text, env: isolatedGitEnv() })
    .toString()
    .trim();

const chain = (expect: string | null, paths: readonly string[], hold = 'clm_1', from?: string) =>
  git.chainCommit({
    repo: repo.path,
    ref: CHAIN,
    expect,
    base: start,
    paths,
    ...(from === undefined ? {} : { from }),
    message: 'Shared change 1 of Settings',
    trailer: { key: '10db-hold', value: hold },
  });

describe('recordPaths', () => {
  it('records the folder as it is, a deleted file included, in an unsigned commit no ref names', async () => {
    write('src/shared.ts', 'dirty before the hold\n');
    unlinkSync(join(repo.path, 'src/button.ts'));
    const index = readFileSync(join(repo.path, '.git/index'));

    const { sha, record } = await git.recordPaths({
      repo: repo.path,
      base: start,
      paths: ['src/shared.ts', 'src/button.ts'],
    });

    expect(record).toEqual([
      { path: 'src/button.ts', blob: null },
      { path: 'src/shared.ts', blob: hash('dirty before the hold\n') },
    ]);
    expect(rawGit('rev-parse', `${sha}^`)).toBe(start);
    expect(rawGit('show', `${sha}:src/shared.ts`)).toBe('dirty before the hold');
    expect(rawGit('ls-tree', '--name-only', '-r', sha, 'src')).toBe('src/shared.ts');
    expect(rawGit('log', '-1', '--format=%G?', sha)).toBe('N');
    expect(rawGit('for-each-ref', 'refs/10db/')).toBe('');
    expect(readFileSync(join(repo.path, '.git/index')).equals(index)).toBe(true);
    expect(rawGit('rev-parse', 'HEAD')).toBe(start);
  });
});

describe('chainCommit', () => {
  it('lays the first change on the start and the next on the tip, unsigned, moving no branch', async () => {
    write('src/shared.ts', 'first\n');
    const first = await chain(null, ['src/shared.ts']);
    expect(first).toMatchObject({
      made: true,
      files: [{ path: 'src/shared.ts', blob: hash('first\n') }],
    });
    expect(rawGit('rev-parse', CHAIN)).toBe(first.sha);
    expect(rawGit('rev-parse', `${CHAIN}^`)).toBe(start);
    expect(rawGit('log', '-1', '--format=%G?%n%(trailers:key=10db-hold,valueonly)', CHAIN)).toBe(
      'N\nclm_1',
    );

    write('src/button.ts', 'second\n');
    const second = await chain(first.sha, ['src/button.ts'], 'clm_2');
    expect(rawGit('rev-parse', `${CHAIN}^`)).toBe(first.sha);
    expect(rawGit('show', `${CHAIN}:src/shared.ts`)).toBe('first');
    expect(rawGit('show', `${CHAIN}:src/button.ts`)).toBe('second');
    expect(second.made).toBe(true);
    expect(rawGit('rev-parse', 'HEAD')).toBe(start);
  });

  it('makes no commit when the paths change nothing, and a rerun finds the commit it made', async () => {
    expect(await chain(null, ['src/shared.ts'])).toEqual({
      sha: null,
      made: false,
      files: [{ path: 'src/shared.ts', blob: hash('shared\n') }],
    });
    expect(rawGit('for-each-ref', CHAIN)).toBe('');

    write('src/shared.ts', 'edited\n');
    const made = await chain(null, ['src/shared.ts']);
    // The ref moved and the daemon stopped before its row: the rerun answers the same commit.
    const again = await chain(made.sha, ['src/shared.ts']);
    expect(again).toMatchObject({ sha: made.sha, made: false });
    // Another hold's change on top: the rerun still finds it below.
    write('src/button.ts', 'another hold\n');
    const other = await chain(made.sha, ['src/button.ts'], 'clm_2');
    expect(await chain(other.sha, ['src/shared.ts'])).toMatchObject({ sha: made.sha, made: false });
    // A further edit makes a new commit on the tip, under the same trailer.
    write('src/shared.ts', 'edited twice\n');
    const further = await chain(other.sha, ['src/shared.ts']);
    expect(further.made).toBe(true);
    expect(rawGit('rev-parse', `${CHAIN}^`)).toBe(other.sha);
  });

  it('refuses a tip it did not read, and moves nothing', async () => {
    write('src/shared.ts', 'one\n');
    const one = await chain(null, ['src/shared.ts']);
    write('src/shared.ts', 'two\n');
    await expect(chain(null, ['src/shared.ts'], 'clm_2')).rejects.toThrow(KeptRefMovedError);
    expect(rawGit('rev-parse', CHAIN)).toBe(one.sha);
  });

  it('takes the paths from a commit when told to, whatever the folder holds', async () => {
    const record = await git.recordPaths({
      repo: repo.path,
      base: start,
      paths: ['src/shared.ts'],
    });
    write('src/shared.ts', 'the hold wrote this\n');
    const kept = await chain(null, ['src/shared.ts']);
    const put = await chain(kept.sha, ['src/shared.ts'], 'drop-1', record.sha);
    expect(put.files).toEqual([{ path: 'src/shared.ts', blob: hash('shared\n') }]);
    expect(rawGit('show', `${CHAIN}:src/shared.ts`)).toBe('shared');
    expect(readFileSync(join(repo.path, 'src/shared.ts'), 'utf8')).toBe('the hold wrote this\n');
  });
});

describe('blobsAt and keepRef', () => {
  it("reads several paths' blobs in one commit, and keeps a commit at a ref", async () => {
    expect(await git.blobsAt(repo.path, start, ['src/shared.ts', 'src/gone.ts'])).toEqual([
      { path: 'src/gone.ts', blob: null },
      { path: 'src/shared.ts', blob: hash('shared\n') },
    ]);
    const ref = 'refs/10db/passes/pas_1/holds/clm_1';
    await git.keepRef(repo.path, ref, start);
    expect(rawGit('rev-parse', ref)).toBe(start);
  });
});

describe('landPaths', () => {
  const land = (from: string, paths: readonly string[], opId = 'shared-pas_1-1') =>
    git.landPaths({
      repo: repo.path,
      branch: '10db/polish',
      from,
      paths,
      message: 'Shared change 1 of Settings',
      opId,
    });

  it('lands the paths as the commit has them, writing no file, and the index follows', async () => {
    write('src/shared.ts', 'kept\n');
    const kept = await chain(null, ['src/shared.ts']);
    if (kept.sha === null) throw new Error('nothing kept');
    write('src/shared.ts', 'kept, then edited again\n');

    const landed = await land(kept.sha, ['src/shared.ts']);

    expect(landed).toMatchObject({ alreadyLanded: false, indexStale: false });
    expect(rawGit('rev-parse', '10db/polish')).toBe(landed.sha);
    expect(rawGit('rev-parse', '10db/polish^')).toBe(start);
    expect(rawGit('show', '10db/polish:src/shared.ts')).toBe('kept');
    expect(readFileSync(join(repo.path, 'src/shared.ts'), 'utf8')).toBe(
      'kept, then edited again\n',
    );
    // The index holds what landed: the later edit is unstaged, nothing is staged.
    expect(rawGit('status', '--porcelain', '--', 'src/shared.ts')).toBe('M src/shared.ts');
  });

  it('answers a rerun with the commit its opId made, and makes none for nothing to land', async () => {
    write('src/shared.ts', 'kept\n');
    const kept = await chain(null, ['src/shared.ts']);
    if (kept.sha === null) throw new Error('nothing kept');
    const landed = await land(kept.sha, ['src/shared.ts']);

    expect(await land(kept.sha, ['src/shared.ts'])).toEqual({
      sha: landed.sha,
      alreadyLanded: true,
      indexStale: false,
    });
    expect(await land(kept.sha, ['src/shared.ts'], 'shared-pas_1-2')).toEqual({
      sha: null,
      alreadyLanded: false,
      indexStale: false,
    });
    expect(rawGit('rev-parse', '10db/polish')).toBe(landed.sha);
  });

  it('is refused while HEAD is off the branch, and moves nothing', async () => {
    write('src/shared.ts', 'kept\n');
    const kept = await chain(null, ['src/shared.ts']);
    if (kept.sha === null) throw new Error('nothing kept');
    rawGit('switch', '-q', 'main');

    await expect(land(kept.sha, ['src/shared.ts'])).rejects.toThrow(PassFolderOffBranchError);
    expect(rawGit('rev-parse', '10db/polish')).toBe(start);
  });

  it("says the folder's index is stale when another git holds it, and its rerun refreshes it", async () => {
    write('src/shared.ts', 'kept\n');
    const kept = await chain(null, ['src/shared.ts']);
    if (kept.sha === null) throw new Error('nothing kept');
    writeFileSync(join(repo.path, '.git/index.lock'), '');

    const landed = await land(kept.sha, ['src/shared.ts']);

    unlinkSync(join(repo.path, '.git/index.lock'));
    expect(landed.indexStale).toBe(true);
    expect(rawGit('show', '10db/polish:src/shared.ts')).toBe('kept');

    // A rerun after a crash finds the commit, and the index follows it now the other git is done.
    expect(await land(kept.sha, ['src/shared.ts'])).toEqual({
      sha: landed.sha,
      alreadyLanded: true,
      indexStale: false,
    });
    expect(rawGit('status', '--porcelain', '--', 'src/shared.ts')).toBe('');
  });
});
