import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

  describe('resolving conflicts', () => {
    const GENERATED = ['packages/db/drizzle/'] as const;
    const resolving = () =>
      git.mergeIntoBranch({
        repo: repo.path,
        branch: 'work',
        from: 'main',
        message: 'Merge main into work',
        resolve: { generated: GENERATED },
      });

    /** A drizzle journal holding `tags`, numbered in order as drizzle-kit writes it. */
    const journal = (...tags: string[]): string =>
      `${JSON.stringify(
        {
          version: '7',
          dialect: 'sqlite',
          entries: tags.map((tag, idx) => ({
            idx,
            version: '6',
            when: idx,
            tag,
            breakpoints: true,
          })),
        },
        null,
        2,
      )}\n`;

    /** Puts `files` in the history both branches share. */
    function seed(files: Record<string, string>): void {
      rawGit('switch', '-q', 'main');
      commitFiles(files, 'seed');
      rawGit('switch', '-q', 'work');
      rawGit('merge', '-q', '--ff-only', 'main');
    }

    it('keeps both sides when each only added lines at the same place, and records which files it resolved', async () => {
      seed({ 'src/index.ts': "import a from './a';\nexport {};\n" });
      const own = commitFiles(
        { 'src/index.ts': "import a from './a';\nimport b from './b';\nexport {};\n" },
        'b',
      );
      const base = onMain(
        { 'src/index.ts': "import a from './a';\nimport c from './c';\nexport {};\n" },
        'c',
      );
      const merged = await resolving();
      expect(merged).toEqual({
        kind: 'merged',
        from: base,
        head: rawGit('rev-parse', 'HEAD'),
        fastForward: false,
        paths: ['src/index.ts'],
        resolved: [{ path: 'src/index.ts', how: 'kept_both' }],
        regenerate: [],
      });
      expect(read('src/index.ts')).toBe(
        "import a from './a';\nimport b from './b';\nimport c from './c';\nexport {};\n",
      );
      expect(rawGit('log', '-1', '--format=%P')).toBe(`${own} ${base}`);
      expect(rawGit('log', '-1', '--format=%B')).toContain('src/index.ts');
      expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it.each([
      {
        name: 'both sides changed the same line',
        seeded: { 'README.md': 'one\ntwo\n' },
        ours: { 'README.md': 'one\nours\n' },
        theirs: { 'README.md': 'one\ntheirs\n' },
        path: 'README.md',
        reason: 'both sides changed the same lines',
      },
      {
        name: 'both sides added the same new file',
        seeded: {},
        ours: { 'src/new.ts': 'ours\n' },
        theirs: { 'src/new.ts': 'theirs\n' },
        path: 'src/new.ts',
        reason: 'both sides added this file',
      },
      {
        name: 'merged JSON that no longer parses',
        seeded: { 'package.json': '{\n  "a": 1,\n  "z": 9\n}\n' },
        ours: { 'package.json': '{\n  "a": 1,\n  "b": 2,\n  "z": 9\n}\n' },
        theirs: { 'package.json': '{\n  "a": 1,\n  "c": 3\n  "z": 9\n}\n' },
        path: 'package.json',
        reason: 'the merged file is not valid JSON',
      },
      {
        // Each side only appended an entry, so a line merge would give two migrations one number.
        name: 'both sides added a migration to a drizzle journal',
        seeded: { 'drizzle/meta/_journal.json': journal('0000_init') },
        ours: { 'drizzle/meta/_journal.json': journal('0000_init', '0001_ours') },
        theirs: { 'drizzle/meta/_journal.json': journal('0000_init', '0001_theirs') },
        path: 'drizzle/meta/_journal.json',
        reason: "drizzle numbers its migrations in order, so its journal isn't merged by line",
      },
    ])('leaves a conflict where $name, and writes nothing', async (c) => {
      if (Object.keys(c.seeded).length > 0) seed(c.seeded);
      commitFiles(c.ours, 'ours');
      onMain(c.theirs, 'theirs');
      const before = snapshot();
      const merged = await resolving();
      expect(merged).toMatchObject({
        kind: 'conflict',
        paths: [c.path],
        unresolved: [{ path: c.path, reason: c.reason }],
      });
      expect(snapshot()).toEqual(before);
    });

    it('does not resolve lines when the caller did not ask', async () => {
      seed({ 'src/index.ts': 'a\nz\n' });
      commitFiles({ 'src/index.ts': 'a\nb\nz\n' }, 'b');
      onMain({ 'src/index.ts': 'a\nc\nz\n' }, 'c');
      expect((await merge()).kind).toBe('conflict');
    });

    it('resets a generated directory to the base, names what the branch had there that the base lacks, and still resolves other files', async () => {
      seed({
        'packages/db/drizzle/meta/_journal.json': '{"entries":["0000"]}\n',
        'packages/db/drizzle/0000_init.sql': 'create table a;\n',
        'src/index.ts': 'a\nz\n',
      });
      commitFiles(
        {
          'packages/db/drizzle/meta/_journal.json': '{"entries":["0000","0001_mine"]}\n',
          'packages/db/drizzle/0001_mine.sql': 'alter table a add b;\n',
          'src/index.ts': 'a\nb\nz\n',
        },
        'mine',
      );
      const base = onMain(
        {
          'packages/db/drizzle/meta/_journal.json': '{"entries":["0000","0001_theirs"]}\n',
          'packages/db/drizzle/0001_theirs.sql': 'alter table a add c;\n',
          'src/index.ts': 'a\nc\nz\n',
        },
        'theirs',
      );
      const merged = await resolving();
      expect(merged).toMatchObject({
        kind: 'merged',
        from: base,
        resolved: [
          { path: 'packages/db/drizzle/', how: 'regenerated' },
          { path: 'src/index.ts', how: 'kept_both' },
        ],
        regenerate: [
          { dir: 'packages/db/drizzle/', dropped: ['packages/db/drizzle/0001_mine.sql'] },
        ],
      });
      expect(read('packages/db/drizzle/meta/_journal.json')).toBe(
        '{"entries":["0000","0001_theirs"]}\n',
      );
      expect(existsSync(join(repo.path, 'packages/db/drizzle/0001_mine.sql'))).toBe(false);
      expect(read('packages/db/drizzle/0001_theirs.sql')).toBe('alter table a add c;\n');
      expect(read('src/index.ts')).toBe('a\nb\nc\nz\n');
      expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('leaves every conflict in a generated directory, with the reason given, when told it cannot be regenerated now', async () => {
      seed({
        'packages/db/drizzle/notes.md': 'a\nz\n',
        'src/index.ts': 'a\nz\n',
      });
      commitFiles(
        { 'packages/db/drizzle/notes.md': 'a\nb\nz\n', 'src/index.ts': 'a\nb\nz\n' },
        'b',
      );
      onMain({ 'packages/db/drizzle/notes.md': 'a\nc\nz\n', 'src/index.ts': 'a\nc\nz\n' }, 'c');
      const before = snapshot();
      const merged = await git.mergeIntoBranch({
        repo: repo.path,
        branch: 'work',
        from: 'main',
        message: 'Merge main into work',
        resolve: { generated: GENERATED, generatedHeld: 'not now' },
      });
      // Only added lines, but a generated file is never merged by line.
      expect(merged).toMatchObject({
        kind: 'conflict',
        paths: ['packages/db/drizzle/notes.md'],
        unresolved: [{ path: 'packages/db/drizzle/notes.md', reason: 'not now' }],
      });
      expect(snapshot()).toEqual(before);
    });

    it("leaves a conflict in a file one side deleted, and in pnpm's lockfile", async () => {
      seed({ 'gone.txt': 'a\n', 'pnpm-lock.yaml': 'a\nz\n' });
      commitFiles({ 'gone.txt': 'changed\n', 'pnpm-lock.yaml': 'a\nb\nz\n' }, 'ours');
      rawGit('switch', '-q', 'main');
      rawGit('rm', '-q', 'gone.txt');
      commitFiles({ 'pnpm-lock.yaml': 'a\nc\nz\n' }, 'theirs');
      rawGit('switch', '-q', 'work');
      expect(await resolving()).toMatchObject({
        kind: 'conflict',
        unresolved: [
          { path: 'gone.txt', reason: 'one side deleted this file and the other changed it' },
          {
            path: 'pnpm-lock.yaml',
            reason: "pnpm's lockfile is made by pnpm, not merged by line",
          },
        ],
      });
    });
  });

  it.each([
    ['an uncommitted change to a file the base changed', 'README.md'],
    ['an untracked file where the base adds one', 'src/theirs.txt'],
  ])('writes nothing when %s is in the way, naming it', async (_case, rel) => {
    commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const base = onMain({ 'README.md': '# theirs\n', 'src/theirs.txt': 'theirs\n' }, 'theirs');
    write(rel, 'a lane is still writing this\n');
    const before = snapshot();
    expect(await merge()).toEqual({ kind: 'blocked', from: base, changed: [rel], kept: [] });
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
      expect(await merge()).toEqual({ kind: 'blocked', from, changed: [], kept: blocked });
      expect(snapshot()).toEqual(before);
      for (const rel of ignored) expect(read(rel)).toBe('the builder keeps this\n');
    });

    it.each([
      {
        name: 'an ignored file the base leaves alone',
        ignore: 'notes.local\n',
        ignored: ['notes.local'],
        base: { 'src/theirs.txt': 'theirs\n' },
      },
      {
        name: 'an ignored directory the base adds a new file to',
        ignore: 'build/\n',
        ignored: ['build/out.js', 'build/cache/x.bin'],
        base: { 'build/new.js': 'theirs\n' },
      },
      {
        name: 'packages a seed copied into a directory the base then starts tracking',
        ignore: 'node_modules/\n',
        ignored: ['packages/foo/node_modules/pkg/index.js'],
        base: { 'packages/foo/package.json': '{}\n' },
      },
    ])('merges past $name, and keeps it', async ({ ignore, ignored, base }) => {
      onMain({ '.gitignore': ignore }, 'ignore rules');
      rawGit('merge', '-q', '--ff-only', 'main');
      commitFiles({ 'src/own.txt': 'own\n' }, 'own');
      onMain(base, 'theirs', true);
      for (const rel of ignored) write(rel, 'kept\n');
      expect((await merge()).kind).toBe('merged');
      for (const rel of ignored) expect(read(rel)).toBe('kept\n');
      for (const [rel, text] of Object.entries(base)) expect(read(rel)).toBe(text);
    });

    it.each([
      // A rename to the decomposed (NFD) spelling passes this check too, but git's own read-tree
      // refuses it on macOS, which folds the two spellings, so it can't be shown merging here.
      { name: 'only its case', from: 'Guide.md', to: 'GUIDE.md' },
    ])('merges a base that renames a tracked file by $name', async ({ from, to }) => {
      onMain({ [from]: 'guide\n' }, 'guide');
      rawGit('merge', '-q', '--ff-only', 'main');
      commitFiles({ 'src/own.txt': 'own\n' }, 'own');
      // Plumbing, so the new name's bytes are exactly as given: git would precompose an NFD argument.
      const blob = rawGit('rev-parse', `main:${from}`);
      const index = join(repo.path, '.git', 'rename-index');
      const plumb = (args: string[], input = '') =>
        execFileSync('git', ['-C', repo.path, ...args], {
          env: { ...isolatedGitEnv(), GIT_INDEX_FILE: index },
          input,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
          .toString()
          .trim();
      plumb(['read-tree', 'main']);
      plumb(
        ['update-index', '-z', '--index-info'],
        [`0 ${'0'.repeat(40)}\t${from}`, `100644 ${blob} 0\t${to}`, ''].join('\0'),
      );
      const tree = plumb(['write-tree']);
      const renamed = plumb(['commit-tree', tree, '-p', 'main'], 'rename\n');
      rawGit('update-ref', 'refs/heads/main', renamed);
      expect(rawGit('ls-tree', '-r', '-z', '--name-only', 'main').split('\0')).toContain(to);
      expect((await merge()).kind).toBe('merged');
      expect(rawGit('ls-files', '-z').split('\0')).toContain(to);
      expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('merges a base that turns a tracked file into a directory', async () => {
      commitFiles({ 'docs/guide': 'a file\n' }, 'a file');
      rawGit('switch', '-q', 'main');
      rawGit('merge', '-q', '--ff-only', 'work');
      rawGit('rm', '-q', '--', 'docs/guide');
      commitFiles({ 'docs/guide/index.md': 'a directory now\n' }, 'a directory');
      rawGit('switch', '-q', 'work');
      commitFiles({ 'src/own.txt': 'own\n' }, 'own');
      expect((await merge()).kind).toBe('merged');
      expect(read('docs/guide/index.md')).toBe('a directory now\n');
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

describe('restoreDirs', () => {
  it('puts the files under the directories back as HEAD has them, and leaves the rest alone', async () => {
    commitFiles({ '.gitignore': 'cache/\n' }, 'ignore');
    commitFiles(
      { 'gen/a.json': '{"a":1}\n', 'gen/gone.json': '{}\n', 'src/schema.ts': 'one\n' },
      'gen',
    );
    write('gen/a.json', '{"a":2, partial');
    rmSync(join(repo.path, 'gen/gone.json'));
    write('gen/new/half.json', '{');
    write('gen/cache/kept.bin', 'ignored\n');
    write('src/schema.ts', 'an edit outside\n');
    expect(await git.restoreDirs(repo.path, ['gen/'])).toEqual([
      'gen/a.json',
      'gen/gone.json',
      'gen/new/half.json',
    ]);
    expect(read('gen/a.json')).toBe('{"a":1}\n');
    expect(read('gen/gone.json')).toBe('{}\n');
    expect(existsSync(join(repo.path, 'gen/new/half.json'))).toBe(false);
    expect(read('gen/cache/kept.bin')).toBe('ignored\n');
    expect(read('src/schema.ts')).toBe('an edit outside\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('M src/schema.ts');
  });

  it('replaces a symlink a run put where a directory was, writing nothing through it', async () => {
    const outside = tempDir('restore-outside');
    try {
      commitFiles({ 'gen/meta/journal.json': '[]\n' }, 'gen');
      rmSync(join(repo.path, 'gen/meta'), { recursive: true });
      symlinkSync(outside.path, join(repo.path, 'gen/meta'));
      await git.restoreDirs(repo.path, ['gen/']);
      expect(lstatSync(join(repo.path, 'gen/meta')).isDirectory()).toBe(true);
      expect(read('gen/meta/journal.json')).toBe('[]\n');
      expect(readdirSync(outside.path)).toEqual([]);
    } finally {
      outside.cleanup();
    }
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

describe('the refs 10db keeps', () => {
  it('lists and deletes refs under refs/10db/, and refuses any other', async () => {
    rawGit('switch', '-q', '-c', 'work');
    const ours = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const theirs = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    for (const id of ['ws-1', 'ws-2'])
      await git.mergedCommit({
        repo: repo.path,
        ours,
        theirs,
        ref: `refs/10db/starts/${id}`,
        message: 'start',
      });
    expect(await git.keptRefs(repo.path, 'refs/10db/starts/')).toEqual([
      'refs/10db/starts/ws-1',
      'refs/10db/starts/ws-2',
    ]);
    await git.deleteKeptRef(repo.path, 'refs/10db/starts/ws-1');
    // Deleting one that is already gone is no error.
    await git.deleteKeptRef(repo.path, 'refs/10db/starts/ws-1');
    expect(await git.keptRefs(repo.path, 'refs/10db/starts/')).toEqual(['refs/10db/starts/ws-2']);
    await expect(git.deleteKeptRef(repo.path, 'refs/heads/main')).rejects.toBeInstanceOf(
      InvalidError,
    );
    await expect(git.keptRefs(repo.path, 'refs/heads/')).rejects.toBeInstanceOf(InvalidError);
    expect(rawGit('rev-parse', 'main')).toBe(theirs);
  });
});
