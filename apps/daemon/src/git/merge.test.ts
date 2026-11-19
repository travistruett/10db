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
import { createGit, GitTrustError, type Git } from './index';

type MergeResolve = NonNullable<Parameters<Git['mergeIntoBranch']>[0]['resolve']>;

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

/** A new repository checked out on a new branch `work`, in place of the one before. */
function freshWork(): void {
  repo.cleanup();
  repo = createTempRepo();
  rawGit('switch', '-q', '-c', 'work');
}

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

const merge = (resolve?: MergeResolve) =>
  git.mergeIntoBranch({
    repo: repo.path,
    branch: 'work',
    from: 'main',
    message: 'Merge main into work',
    ...(resolve ? { resolve } : {}),
  });

describe('mergeIntoBranch', () => {
  beforeEach(() => {
    rawGit('switch', '-q', '-c', 'work');
  });

  it('merges a base that moved on: a merge commit with the branch first, both sides in the files, nothing uncommitted; rewindBranch takes it back, keeping a file of the builder', async () => {
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

    // The branch, the files and the index return; a file of the builder stays.
    const head = merged.kind === 'merged' ? merged.head : '';
    write('notes.txt', 'mine\n');
    await git.rewindBranch(repo.path, 'work', head, own);
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(own);
    expect(existsSync(join(repo.path, 'src/theirs.txt'))).toBe(false);
    expect(read('src/own.txt')).toBe('own\n');
    expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('?? notes.txt');
  });

  it('rewindBranch refuses a branch that moved, or a target the tip does not descend from, and moves a branch that is not checked out by its ref alone', async () => {
    const own = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    const next = commitFiles({ 'src/more.txt': 'more\n' }, 'more');
    const other = onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    await expect(git.rewindBranch(repo.path, 'work', own, own)).rejects.toBeInstanceOf(
      InvalidError,
    );
    await expect(git.rewindBranch(repo.path, 'work', next, other)).rejects.toBeInstanceOf(
      InvalidError,
    );
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(next);

    rawGit('switch', '-q', 'main');
    await git.rewindBranch(repo.path, 'work', next, own);
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(own);
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

  describe('writing nothing, naming why', () => {
    /** A base with `base` committed past `.gitignore`'s rules, and `ignored` written in the checkout. */
    const ignoredInTheWay = (base: Record<string, string>, ignored: string[], kept: string[]) => ({
      arrange: () => {
        onMain({ '.gitignore': 'secret.env\nbuild/\ncache\n' }, 'ignore rules');
        rawGit('merge', '-q', '--ff-only', 'main');
        commitFiles({ 'src/own.txt': 'own\n' }, 'own');
        const from = onMain(base, 'theirs', true);
        for (const rel of ignored) write(rel, 'the builder keeps this\n');
        return { kind: 'blocked', from, changed: [], kept };
      },
      files: Object.fromEntries(ignored.map((rel) => [rel, 'the builder keeps this\n'])),
    });
    const inTheWay = (rel: string) => ({
      arrange: () => {
        commitFiles({ 'src/own.txt': 'own\n' }, 'own');
        const from = onMain({ 'README.md': '# theirs\n', 'src/theirs.txt': 'theirs\n' }, 'theirs');
        write(rel, 'a lane is still writing this\n');
        return { kind: 'blocked', from, changed: [rel], kept: [] };
      },
      files: { [rel]: 'a lane is still writing this\n' },
    });
    interface Row {
      name: string;
      /** Makes the history; returns what the merge answers. */
      arrange: () => unknown;
      /** Files the merge must leave as they are, or that must not exist (null). */
      files: Record<string, string | null>;
    }
    /** Merges each row's history in a repository of its own, checking it writes nothing. */
    async function mergesNothing(rows: readonly Row[]): Promise<void> {
      for (const row of rows) {
        freshWork();
        const expected = row.arrange();
        const before = snapshot();
        const merged = await merge().catch((error: unknown) =>
          error instanceof GitTrustError ? { refused: error.detail } : error,
        );
        expect.soft(merged, row.name).toEqual(expected);
        expect.soft(snapshot(), row.name).toEqual(before);
        for (const [rel, text] of Object.entries(row.files))
          expect
            .soft(
              text === null ? existsSync(join(repo.path, rel)) : read(rel),
              `${row.name}: ${rel}`,
            )
            .toBe(text ?? false);
      }
    }

    it('when the branch already holds the base, a file conflicts, or the base asks for a filter', async () => {
      await mergesNothing([
        {
          name: 'the branch already holds the base',
          arrange: () => {
            const from = rawGit('rev-parse', 'main');
            commitFiles({ 'src/own.txt': 'own\n' }, 'own');
            return { kind: 'up_to_date', from };
          },
          files: {},
        },
        {
          name: 'a conflict',
          arrange: () => {
            commitFiles({ 'README.md': '# ours\n', 'src/own.txt': 'own\n' }, 'own');
            const from = onMain(
              { 'README.md': '# theirs\n', 'src/theirs.txt': 'theirs\n' },
              'theirs',
            );
            return { kind: 'conflict', from, paths: ['README.md'] };
          },
          files: { 'README.md': '# ours\n', 'src/theirs.txt': null },
        },
        {
          name: 'a base whose tree asks for a filter',
          arrange: () => {
            commitFiles({ 'src/own.txt': 'own\n' }, 'own');
            onMain({ '.gitattributes': '*.bin filter=lfs\n' }, 'lfs');
            return {
              refused: { kind: 'filter', paths: [{ path: '.gitattributes', filter: 'lfs' }] },
            };
          },
          files: {},
        },
      ]);
    });

    it('when an uncommitted change or an untracked file is in the way, naming it', async () => {
      await mergesNothing([
        { name: 'an uncommitted change to a file the base changed', ...inTheWay('README.md') },
        { name: 'an untracked file where the base adds one', ...inTheWay('src/theirs.txt') },
      ]);
    });

    it('when an ignored file or directory that read-tree would overwrite or delete is in the way, naming it', async () => {
      await mergesNothing([
        {
          name: 'an ignored file where the base commits one',
          ...ignoredInTheWay({ 'secret.env': 'theirs\n' }, ['secret.env'], ['secret.env']),
        },
        {
          name: 'an ignored directory where the base commits a file of that name',
          ...ignoredInTheWay({ build: 'a file now\n' }, ['build/out.js'], ['build/']),
        },
        {
          name: 'an ignored file where the base commits a directory of that name',
          ...ignoredInTheWay({ 'cache/kept.txt': 'theirs\n' }, ['cache'], ['cache']),
        },
      ]);
    });
  });

  describe('resolving conflicts', () => {
    const GENERATED = ['packages/db/drizzle/'] as const;
    const RESOLVING: MergeResolve = { generated: GENERATED };
    const MARKING: MergeResolve = { generated: GENERATED, leaveMarkers: true };

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

    it('keeps both sides when each only added lines at the same place, only when the caller asks, and records which files it resolved', async () => {
      seed({ 'src/index.ts': "import a from './a';\nexport {};\n" });
      const own = commitFiles(
        { 'src/index.ts': "import a from './a';\nimport b from './b';\nexport {};\n" },
        'b',
      );
      const base = onMain(
        { 'src/index.ts': "import a from './a';\nimport c from './c';\nexport {};\n" },
        'c',
      );
      expect((await merge()).kind).toBe('conflict');
      const merged = await merge(RESOLVING);
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

    /** Seeds `seeded`, then commits `ours` on work and `theirs` on main. */
    const sides =
      (
        seeded: Record<string, string>,
        ours: Record<string, string>,
        theirs: Record<string, string>,
      ) =>
      () => {
        if (Object.keys(seeded).length > 0) seed(seeded);
        commitFiles(ours, 'ours');
        onMain(theirs, 'theirs');
      };
    /**
     * Merges each row's history in a repository of its own: a conflict, as `result` says, that
     * writes nothing.
     */
    async function leavesConflict(
      rows: readonly {
        name: string;
        arrange: () => void;
        resolve: MergeResolve;
        result: Record<string, unknown>;
      }[],
    ): Promise<void> {
      for (const row of rows) {
        freshWork();
        row.arrange();
        const from = rawGit('rev-parse', 'main');
        const before = snapshot();
        expect.soft(await merge(row.resolve), row.name).toMatchObject({ ...row.result, from });
        expect.soft(snapshot(), row.name).toEqual(before);
      }
    }

    it('leaves a conflict where both sides changed a line or added the same file, and writes nothing', async () => {
      await leavesConflict([
        {
          name: 'both sides changed the same line',
          arrange: sides(
            { 'README.md': 'one\ntwo\n' },
            { 'README.md': 'one\nours\n' },
            { 'README.md': 'one\ntheirs\n' },
          ),
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            paths: ['README.md'],
            unresolved: [{ path: 'README.md', reason: 'both sides changed the same lines' }],
          },
        },
        {
          name: 'both sides added the same new file',
          arrange: sides({}, { 'src/new.ts': 'ours\n' }, { 'src/new.ts': 'theirs\n' }),
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            paths: ['src/new.ts'],
            unresolved: [{ path: 'src/new.ts', reason: 'both sides added this file' }],
          },
        },
      ]);
    });

    it('leaves a conflict where the merged JSON or drizzle journal would be wrong, and writes nothing', async () => {
      await leavesConflict([
        {
          name: 'merged JSON that no longer parses',
          arrange: sides(
            { 'package.json': '{\n  "a": 1,\n  "z": 9\n}\n' },
            { 'package.json': '{\n  "a": 1,\n  "b": 2,\n  "z": 9\n}\n' },
            { 'package.json': '{\n  "a": 1,\n  "c": 3\n  "z": 9\n}\n' },
          ),
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            paths: ['package.json'],
            unresolved: [{ path: 'package.json', reason: 'the merged file is not valid JSON' }],
          },
        },
        {
          // Each side only appended an entry, so a line merge would give two migrations one number.
          name: 'both sides added a migration to a drizzle journal',
          arrange: sides(
            { 'drizzle/meta/_journal.json': journal('0000_init') },
            { 'drizzle/meta/_journal.json': journal('0000_init', '0001_ours') },
            { 'drizzle/meta/_journal.json': journal('0000_init', '0001_theirs') },
          ),
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            paths: ['drizzle/meta/_journal.json'],
            unresolved: [
              {
                path: 'drizzle/meta/_journal.json',
                reason:
                  "drizzle numbers its migrations in order, so its journal isn't merged by line",
              },
            ],
          },
        },
      ]);
    });

    it('names every conflicted path of a merge it leaves, and leaves every conflict in a generated directory it is told cannot be regenerated now', async () => {
      await leavesConflict([
        {
          // Its conflicts list every conflicted path, those it would have settled included.
          name: 'a conflict beside a generated journal it would have settled',
          arrange: sides(
            {
              'packages/db/drizzle/meta/_journal.json': journal('0000_init'),
              'README.md': '# base\n',
            },
            {
              'packages/db/drizzle/meta/_journal.json': journal('0000_init', '0001_mine'),
              'README.md': '# ours\n',
            },
            {
              'packages/db/drizzle/meta/_journal.json': journal('0000_init', '0001_theirs'),
              'README.md': '# theirs\n',
            },
          ),
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            paths: ['README.md'],
            unresolved: [{ path: 'README.md' }],
            conflicted: ['README.md', 'packages/db/drizzle/meta/_journal.json'],
          },
        },
        {
          // Only added lines, but a generated file is never merged by line.
          name: 'a generated directory the caller says cannot be regenerated now',
          arrange: sides(
            { 'packages/db/drizzle/notes.md': 'a\nz\n', 'src/index.ts': 'a\nz\n' },
            { 'packages/db/drizzle/notes.md': 'a\nb\nz\n', 'src/index.ts': 'a\nb\nz\n' },
            { 'packages/db/drizzle/notes.md': 'a\nc\nz\n', 'src/index.ts': 'a\nc\nz\n' },
          ),
          resolve: { generated: GENERATED, generatedHeld: 'not now' },
          result: {
            kind: 'conflict',
            paths: ['packages/db/drizzle/notes.md'],
            unresolved: [{ path: 'packages/db/drizzle/notes.md', reason: 'not now' }],
          },
        },
      ]);
    });

    it("leaves a conflict in a file one side deleted and in pnpm's lockfile, even when it may leave markers", async () => {
      await leavesConflict([
        {
          name: "a file one side deleted, and pnpm's lockfile",
          arrange: () => {
            seed({ 'gone.txt': 'a\n', 'pnpm-lock.yaml': 'a\nz\n' });
            commitFiles({ 'gone.txt': 'changed\n', 'pnpm-lock.yaml': 'a\nb\nz\n' }, 'ours');
            rawGit('switch', '-q', 'main');
            rawGit('rm', '-q', 'gone.txt');
            commitFiles({ 'pnpm-lock.yaml': 'a\nc\nz\n' }, 'theirs');
            rawGit('switch', '-q', 'work');
          },
          resolve: RESOLVING,
          result: {
            kind: 'conflict',
            unresolved: [
              { path: 'gone.txt', reason: 'one side deleted this file and the other changed it' },
              {
                path: 'pnpm-lock.yaml',
                reason: "pnpm's lockfile is made by pnpm, not merged by line",
              },
            ],
          },
        },
        {
          name: 'a deleted file, left for a session to mark, which markers cannot show',
          arrange: () => {
            seed({ 'src/gone.ts': 'one\n', 'src/type.ts': 'a\n' });
            rawGit('rm', '-q', 'src/gone.ts');
            commitFiles({ 'src/type.ts': 'b\n' }, 'own');
            onMain({ 'src/gone.ts': 'two\n', 'src/type.ts': 'c\n' }, 'theirs');
          },
          resolve: MARKING,
          result: { kind: 'conflict' },
        },
      ]);
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
      const merged = await merge(RESOLVING);
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

    describe('leaving markers for a session', () => {
      it('commits the merge with markers where both sides changed the same lines, the base as second parent, settles the rest, and names the files that still hold them', async () => {
        seed({
          'src/type.ts': 'export type T = {\n  id: string;\n};\n',
          'src/index.ts': "import a from './a';\nexport {};\n",
        });
        const own = commitFiles(
          {
            'src/type.ts': 'export type T = {\n  id: number;\n};\n',
            'src/index.ts': "import a from './a';\nimport b from './b';\nexport {};\n",
          },
          'own',
        );
        const base = onMain(
          {
            'src/type.ts': 'export type T = {\n  id: bigint;\n};\n',
            'src/index.ts': "import a from './a';\nimport c from './c';\nexport {};\n",
          },
          'theirs',
        );
        const merged = await merge(MARKING);
        expect(merged).toEqual({
          kind: 'merged',
          from: base,
          head: rawGit('rev-parse', 'HEAD'),
          fastForward: false,
          paths: ['src/index.ts', 'src/type.ts'],
          resolved: [{ path: 'src/index.ts', how: 'kept_both' }],
          regenerate: [],
          marked: ['src/type.ts'],
        });
        expect(rawGit('log', '-1', '--format=%P')).toBe(`${own} ${base}`);
        expect(rawGit('rev-parse', 'refs/heads/work')).toBe(rawGit('rev-parse', 'HEAD'));
        expect(read('src/type.ts')).toContain('<<<<<<< ');
        expect(read('src/type.ts')).toContain('  id: number;');
        expect(read('src/type.ts')).toContain('  id: bigint;');
        expect(read('src/type.ts')).toContain('>>>>>>> ');
        expect(read('src/index.ts')).toContain("import b from './b';\nimport c from './c';");
        expect(rawGit('status', '--porcelain', '--untracked-files=all')).toBe('');
        expect(rawGit('log', '-1', '--format=%B')).toContain('src/type.ts');

        // The files that still hold the markers the merge left, and none once they are gone.
        const files = ['src/type.ts', 'src/index.ts'];
        expect(await git.conflictMarkers(repo.path, files)).toEqual(['src/type.ts']);
        commitFiles({ 'src/type.ts': 'export type T = {\n  id: bigint;\n};\n' }, 'resolved');
        expect(await git.conflictMarkers(repo.path, files)).toEqual([]);
        expect(await git.conflictMarkers(repo.path, files, 'HEAD^')).toEqual(['src/type.ts']);
      });

      it('takes the base whole for a generated directory beside a marked file, leaving its regeneration to the caller', async () => {
        seed({
          'src/schema.ts': 'export const a = 1;\n',
          'packages/db/drizzle/0000_a.sql': 'a\n',
        });
        commitFiles(
          {
            'src/schema.ts': 'export const a = 2;\n',
            'packages/db/drizzle/0000_a.sql': 'own\n',
            'packages/db/drizzle/0001_own.sql': 'own\n',
          },
          'own',
        );
        onMain(
          {
            'src/schema.ts': 'export const a = 3;\n',
            'packages/db/drizzle/0000_a.sql': 'theirs\n',
            'packages/db/drizzle/0001_theirs.sql': 'theirs\n',
          },
          'theirs',
        );
        const merged = await merge(MARKING);
        if (merged.kind !== 'merged') throw new Error(`expected a merge, got ${merged.kind}`);
        expect(merged.marked).toEqual(['src/schema.ts']);
        expect(merged.regenerate).toEqual([
          { dir: 'packages/db/drizzle/', dropped: ['packages/db/drizzle/0001_own.sql'] },
        ]);
        expect(existsSync(join(repo.path, 'packages/db/drizzle/0001_own.sql'))).toBe(false);
        expect(read('packages/db/drizzle/0001_theirs.sql')).toBe('theirs\n');
      });
    });
  });

  describe('ignored files, which read-tree would overwrite or delete', () => {
    it('merges past an ignored file or directory the base leaves alone or adds beside, and keeps it', async () => {
      const rows = [
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
      ];
      for (const { name, ignore, ignored, base } of rows) {
        freshWork();
        onMain({ '.gitignore': ignore }, 'ignore rules');
        rawGit('merge', '-q', '--ff-only', 'main');
        commitFiles({ 'src/own.txt': 'own\n' }, 'own');
        onMain(base, 'theirs', true);
        for (const rel of ignored) write(rel, 'kept\n');
        expect.soft((await merge()).kind, name).toBe('merged');
        for (const rel of ignored) expect.soft(read(rel), `${name}: ${rel}`).toBe('kept\n');
        for (const [rel, text] of Object.entries(base))
          expect.soft(read(rel), `${name}: ${rel}`).toBe(text);
      }
    });

    it('merges a base that renames a tracked file by only its case, or turns a tracked file into a directory', async () => {
      // A rename to the decomposed (NFD) spelling passes this check too, but git's own read-tree
      // refuses it on macOS, which folds the two spellings, so it can't be shown merging here.
      const from = 'Guide.md';
      const to = 'GUIDE.md';
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

      freshWork();
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

  it('refuses a checkout that is not on the branch', async () => {
    onMain({ 'src/theirs.txt': 'theirs\n' }, 'theirs');
    rawGit('switch', '-q', 'main');
    await expect(merge()).rejects.toBeInstanceOf(InvalidError);
    expect(rawGit('rev-parse', 'refs/heads/work')).toBe(rawGit('rev-parse', 'main~1'));
  });
});

describe('after a merge', () => {
  it("commitsSince lists the branch's own commits, and a retried commit is not mistaken for one on the base that carries the same operation id", async () => {
    rawGit('switch', '-q', '-c', 'work');
    const start = rawGit('rev-parse', 'HEAD');
    const own = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    // A squash-merged pull request keeps the 10db-Op trailers of the lane commits it folds in.
    rawGit('switch', '-q', 'main');
    write('src/theirs.txt', 'theirs\n');
    rawGit('add', '--', 'src/theirs.txt');
    rawGit('commit', '-q', '-m', 'theirs', '--trailer', '10db-Op: op-merged-1');
    rawGit('switch', '-q', 'work');
    onMain({ 'src/b.txt': 'b\n' }, 'b');
    const merged = await merge();
    if (merged.kind !== 'merged') throw new Error(`expected a merge, got ${merged.kind}`);
    expect(await git.commitsSince(repo.path, start)).toEqual([own, merged.head]);
    expect(await git.commitsSince(repo.path, merged.from)).toEqual([own, merged.head]);

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

  it('records the merge of two commits at a 10db ref, touching no file, index or branch; lists and deletes refs under refs/10db/, and refuses any other', async () => {
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

    await expect(mergedCommit(ours, theirs, 'refs/heads/main')).rejects.toBeInstanceOf(
      InvalidError,
    );
    expect(rawGit('rev-parse', 'main')).toBe(theirs);

    await mergedCommit(ours, theirs, 'refs/10db/starts/ws-2');
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

  it('answers theirs when ours is its ancestor, ours when it already holds theirs, and null on a conflict, recording nothing', async () => {
    const older = rawGit('rev-parse', 'HEAD');
    const newer = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    for (const [name, ours, theirs] of [
      ['theirs when ours is its ancestor', older, newer],
      ['ours when ours already holds theirs', newer, older],
    ] as const) {
      expect.soft(await mergedCommit(ours, theirs), name).toBe(newer);
      expect
        .soft(() => rawGit('rev-parse', '--verify', '-q', 'refs/10db/starts/ws-1'), name)
        .toThrow();
    }

    const ours = commitFiles({ 'README.md': '# ours\n' }, 'own');
    const theirs = onMain({ 'README.md': '# theirs\n' }, 'theirs');
    expect(await mergedCommit(ours, theirs)).toBeNull();
    expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/10db/starts/ws-1')).toThrow();
  });
});

describe('restoreDirs', () => {
  it('puts the files under the directories back as HEAD has them, leaves the rest alone, and replaces a symlink a run put where a directory was, writing nothing through it', async () => {
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

    const outside = tempDir('restore-outside');
    try {
      commitFiles({ 'gen/meta/journal.json': '[]\n' }, 'gen meta');
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
  it('names the blob of a file in a commit, null for a path that holds none, and tells whether one commit is in the history of another', async () => {
    const older = rawGit('rev-parse', 'HEAD');
    expect(await git.blobAt(repo.path, older, 'README.md')).toBe(
      rawGit('rev-parse', `${older}:README.md`),
    );
    expect(await git.blobAt(repo.path, older, 'pnpm-lock.yaml')).toBeNull();
    const newer = commitFiles({ 'src/own.txt': 'own\n' }, 'own');
    expect(await git.isAncestor(repo.path, older, newer)).toBe(true);
    expect(await git.isAncestor(repo.path, newer, older)).toBe(false);
  });
});

describe('a note 10db keeps at a ref', () => {
  it('reads back what was kept, replaces it, and is gone once the ref is deleted', async () => {
    const ref = 'refs/10db/root/merges/bat-1';
    expect(await git.keptNote(repo.path, ref)).toBeNull();
    await git.keepNote(repo.path, ref, '{"from":"abc"}');
    expect(await git.keptNote(repo.path, ref)).toBe('{"from":"abc"}');
    await git.keepNote(repo.path, ref, 'second');
    expect(await git.keptNote(repo.path, ref)).toBe('second');
    expect(await git.keptRefs(repo.path, 'refs/10db/root/merges/')).toEqual([ref]);
    await git.deleteKeptRef(repo.path, ref);
    expect(await git.keptNote(repo.path, ref)).toBeNull();
    await expect(git.keepNote(repo.path, 'refs/heads/main', 'x')).rejects.toBeInstanceOf(
      InvalidError,
    );
  });
});
