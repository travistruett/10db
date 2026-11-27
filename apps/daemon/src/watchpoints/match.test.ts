import { describe, expect, it } from 'vitest';
import {
  effectiveWatchpoints,
  isNoisyWatchpoint,
  Watchpoint as WatchpointSchema,
  revisedWatchpoints,
  STARTER_REVISION,
  STARTER_WATCHPOINTS,
  WatchpointFileStatus,
  WatchpointLoudness,
  type Watchpoint,
  type WatchpointFileHit,
} from '@10db/contracts';
import { evalDefinitionSource } from './eval-definition-source';
import { lineChecks, questionCandidates } from './covers';
import { runChecks } from './line-verdicts';
import { watchpointHitsAfter } from './hits-after';
import { matchWatchpoints } from './match';
import { splitPatch } from './split-patch';

const watchpoint = (key: string, globs: string[], over: Partial<Watchpoint> = {}): Watchpoint => ({
  key,
  label: key,
  why: `why ${key}`,
  globs,
  lines: [],
  question: null,
  guidance: `check ${key}`,
  knowledge: [],
  loudness: WatchpointLoudness.Show,
  starter: null,
  ...over,
});

const file = (path: string, over: Partial<WatchpointFileHit> = {}): WatchpointFileHit => ({
  path,
  status: WatchpointFileStatus.Modified,
  added: 3,
  removed: 1,
  patch: `diff --git a/${path} b/${path}\n`,
  clipped: false,
  ...over,
});

const keys = (hits: ReturnType<typeof matchWatchpoints>) => hits.map((h) => h.watchpoint.key);

describe('matchWatchpoints', () => {
  it('matches a glob across dot folders and names', () => {
    const hits = matchWatchpoints(
      [file('.codex/AGENTS.md'), file('.claude/.hidden/rule.md'), file('src/a.ts')],
      [watchpoint('agent', ['**/AGENTS.md', '.claude/**'])],
    );
    expect(hits.map((h) => h.files.map((f) => f.path))).toEqual([
      ['.codex/AGENTS.md', '.claude/.hidden/rule.md'],
    ]);
  });

  it('puts one file under every watchpoint that covers it, and drops a watchpoint nothing hits', () => {
    const hits = matchWatchpoints(
      [file('packages/contracts/prompts/a.ts')],
      [
        watchpoint('contracts', ['**/contracts/**']),
        watchpoint('prompts', ['**/prompts/**']),
        watchpoint('evals', ['**/evals/**']),
      ],
    );
    expect(keys(hits)).toEqual(['contracts', 'prompts']);
  });

  it('keeps a clipped file clipped, and snapshots the watchpoint without its globs', () => {
    const [hit] = matchWatchpoints(
      [file('db/migrations/0001.sql', { patch: '', clipped: true })],
      [watchpoint('migrations', ['**/migrations/**'], { loudness: WatchpointLoudness.Ask })],
    );
    expect(hit?.files[0]?.clipped).toBe(true);
    expect(hit?.watchpoint).toEqual({
      key: 'migrations',
      label: 'migrations',
      why: 'why migrations',
      guidance: 'check migrations',
      loudness: 'ask',
    });
  });
});

describe('matchWatchpoints with line patterns', () => {
  const patch = (path: string, body: string[]): string =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,3 +1,3 @@',
      ...body,
    ].join('\n') + '\n';
  const lined = watchpoint('lined', ['src/**'], { lines: ['\\bfoo\\b'] });
  const hitPaths = (files: WatchpointFileHit[], w: Watchpoint = lined) =>
    matchWatchpoints(files, [w], runChecks(lineChecks(files, [w]))).flatMap((h) =>
      h.files.map((f) => f.path),
    );

  it('hits on a matching added or removed line, in any case', () => {
    expect(hitPaths([file('src/a.ts', { patch: patch('src/a.ts', ['+let FOO = 1;']) })])).toEqual([
      'src/a.ts',
    ]);
    expect(hitPaths([file('src/b.ts', { patch: patch('src/b.ts', ['-call(foo)']) })])).toEqual([
      'src/b.ts',
    ]);
  });

  it('does not hit on a context line, a header, or a covered file with no matching line', () => {
    expect(
      hitPaths([file('src/c.ts', { patch: patch('src/c.ts', [' foo stays', '+bar']) })]),
    ).toEqual([]);
    expect(hitPaths([file('src/foo.ts', { patch: patch('src/foo.ts', ['+bar']) })])).toEqual([]);
    expect(hitPaths([file('docs/a.md', { patch: patch('docs/a.md', ['+foo']) })])).toEqual([]);
  });

  it('hits Indexes on CREATE UNIQUE INDEX in a migration, and Model choice on a model id in code', () => {
    const starter = (key: string): Watchpoint => {
      const found = STARTER_WATCHPOINTS.find((w) => w.key === key);
      if (found === undefined) throw new Error(`no ${key} starter`);
      return found;
    };
    const sql = 'db/migrations/0002.sql';
    expect(
      hitPaths(
        [file(sql, { patch: patch(sql, ['+CREATE UNIQUE INDEX ix_a ON t (a);']) })],
        starter('indexes'),
      ),
    ).toEqual([sql]);
    expect(
      hitPaths(
        [file('src/x.ts', { patch: patch('src/x.ts', ["+const m = 'claude-sonnet-5-5';"]) })],
        starter('model-choice'),
      ),
    ).toEqual(['src/x.ts']);
  });

  it('counts a clipped file with no matching line for an ask watchpoint, and not for a show one', () => {
    const cut = file('src/d.ts', { patch: patch('src/d.ts', ['+bar']), clipped: true });
    const unread = file('src/e.ts', { patch: '', clipped: true });
    const asking = { ...lined, loudness: WatchpointLoudness.Ask };
    expect(hitPaths([cut, unread], asking)).toEqual(['src/d.ts', 'src/e.ts']);
    expect(hitPaths([cut, unread])).toEqual([]);
    expect(hitPaths([file('src/f.ts', { patch: patch('src/f.ts', ['+bar']) })], asking)).toEqual(
      [],
    );
  });

  it('reads CRLF lines to their end, and fails closed on a cut line or an unanswered pattern', () => {
    const ends = watchpoint('ends', ['src/**'], { lines: ['foo$'] });
    const crlf = file('src/g.ts', { patch: patch('src/g.ts', ['+let foo\r']) });
    expect(hitPaths([crlf], ends)).toEqual(['src/g.ts']);
    const asking = { ...lined, loudness: WatchpointLoudness.Ask };
    const long = file('src/h.ts', { patch: patch('src/h.ts', [`+${'x'.repeat(2500)}`]) });
    expect(hitPaths([long], asking)).toEqual(['src/h.ts']);
    expect(hitPaths([long])).toEqual([]);
    const plain = file('src/i.ts', { patch: patch('src/i.ts', ['+bar']) });
    // No verdict at all, as when the worker timed out: ask counts the file, show does not.
    expect(matchWatchpoints([plain], [asking]).length).toBe(1);
    expect(matchWatchpoints([plain], [lined])).toEqual([]);
  });

  it('counts a binary or hidden file of an ask watchpoint, whose lines could not be read', () => {
    const asking = { ...lined, loudness: WatchpointLoudness.Ask };
    const hidden = (path: string, over: Partial<WatchpointFileHit>) =>
      file(path, {
        patch: `diff --git a/${path} b/${path}\nBinary files a/${path} and b/${path} differ\n`,
        ...over,
      });
    const binary = hidden('src/b.bin', { added: null, removed: null });
    expect(hitPaths([binary], asking)).toEqual(['src/b.bin']);
    expect(hitPaths([binary])).toEqual([]);
    expect(hitPaths([hidden('src/mode.sh', { added: 0, removed: 0 })], asking)).toEqual([]);
  });

  it('makes no rule hit for a question watchpoint with no lines, and asks about every file its globs cover', () => {
    const asking = watchpoint('auth', ['src/**'], {
      question: 'Does this change who can do what?',
      loudness: WatchpointLoudness.Ask,
    });
    const files = [
      file('src/a.ts', { patch: patch('src/a.ts', ['+bar']) }),
      file('src/b.ts', { patch: '', clipped: true }),
      file('docs/c.md'),
    ];
    const verdicts = runChecks(lineChecks(files, [asking]));
    expect(matchWatchpoints(files, [asking], verdicts)).toEqual([]);
    expect(questionCandidates(files, [asking], verdicts)).toEqual([
      {
        key: 'auth',
        label: 'auth',
        question: 'Does this change who can do what?',
        paths: ['src/a.ts', 'src/b.ts'],
      },
    ]);
  });

  it('settles a file a line matched, so only the files no line settled are asked about', () => {
    const both = watchpoint('both', ['src/**'], { lines: ['\\bfoo\\b'], question: 'Is it risky?' });
    const files = [
      file('src/a.ts', { patch: patch('src/a.ts', ['+let foo = 1;']) }),
      file('src/b.ts', { patch: patch('src/b.ts', ['+bar']) }),
    ];
    const verdicts = runChecks(lineChecks(files, [both]));
    expect(hitPaths(files, both)).toEqual(['src/a.ts']);
    expect(questionCandidates(files, [both], verdicts).map((c) => c.paths)).toEqual([['src/b.ts']]);
    expect(questionCandidates(files, [lined], verdicts)).toEqual([]);
  });

  it('reads a stored watchpoint with no lines as having none', () => {
    const stored: Record<string, unknown> = { ...watchpoint('old', ['a/**']) };
    delete stored['lines'];
    expect(WatchpointSchema.parse(stored).lines).toEqual([]);
  });
});

describe('effectiveWatchpoints', () => {
  const yours = [
    watchpoint('migrations', ['**/migrations/**']),
    watchpoint('prompts', ['**/prompts/**']),
  ];

  it('lets a project override one of yours by key, add its own, and turn one off', () => {
    const override = watchpoint('migrations', ['db/**'], { why: 'this project' });
    const own = watchpoint('infra', ['infra/**']);
    const list = effectiveWatchpoints(yours, [override, own, { key: 'prompts', off: true }]);
    expect(list.map((f) => [f.key, f.from])).toEqual([
      ['migrations', 'override'],
      ['infra', 'project'],
    ]);
    expect(list[0]?.globs).toEqual(['db/**']);
  });

  it('tags the rest as yours, and ignores an off entry for a key you lack', () => {
    const list = effectiveWatchpoints(yours, [{ key: 'unknown', off: true }]);
    expect(list.map((f) => [f.key, f.from])).toEqual([
      ['migrations', 'you'],
      ['prompts', 'you'],
    ]);
  });
});

describe('splitPatch', () => {
  // A real `git diff-tree -p --no-renames` of one commit: a modified, an added and a deleted file, a rename
  // (shown as a delete and an add), a path with spaces and two that git quotes (an accented name in octal bytes, and a bell), whose ---/+++ lines git ends with a tab.
  const diff = [
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    'index 0000000..92d5444',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1 @@',
    '+fresh',
    'diff --git a/dir with space/a b.md b/dir with space/a b.md',
    'index 587be6b..975fbec 100644',
    '--- a/dir with space/a b.md\t',
    '+++ b/dir with space/a b.md\t',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'index 1111111..2222222 100644',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git "a/bell\\a.txt" "b/bell\\a.txt"',
    'index 3333333..4444444 100644',
    '--- "a/bell\\a.txt"',
    '+++ "b/bell\\a.txt"',
    '@@ -1 +1 @@',
    '-c',
    '+d',
    'diff --git a/mod.txt b/mod.txt',
    'index 814f4a4..879de50 100644',
    '--- a/mod.txt',
    '+++ b/mod.txt',
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+TWO',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..ed0d042',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,3 @@',
    '+moved',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    'index ed0d042..0000000',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-moved',
    '',
  ].join('\n');

  it('keys each file by its path, with its status, and keeps the hunks under its own header', () => {
    const found = splitPatch(diff, { fileBytes: 24 * 1024, diffCut: false });
    expect([...found.values()].map((f) => [f.path, f.status, f.clipped])).toEqual([
      ['added.txt', 'A', false],
      ['dir with space/a b.md', 'M', false],
      ['café.txt', 'M', false],
      ['bell\x07.txt', 'M', false],
      ['mod.txt', 'M', false],
      ['new.txt', 'A', false],
      ['old.txt', 'D', false],
    ]);
    expect(found.get('mod.txt')?.patch).toBe(
      'diff --git a/mod.txt b/mod.txt\nindex 814f4a4..879de50 100644\n--- a/mod.txt\n+++ b/mod.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
    );
  });

  it('clips the last file when the diff itself was cut, and a file past its own cap', () => {
    const cut = splitPatch(diff, { fileBytes: 40, diffCut: true });
    expect(cut.get('old.txt')?.clipped).toBe(true);
    expect(cut.get('mod.txt')?.clipped).toBe(true);
    expect(cut.get('mod.txt')?.patch.endsWith('\n')).toBe(true);
    expect(splitPatch(diff, { fileBytes: 24 * 1024, diffCut: true }).get('mod.txt')?.clipped).toBe(
      false,
    );
  });
});

describe('revisedWatchpoints', () => {
  const firstShippedMigrations = (over: Partial<Watchpoint> = {}): Watchpoint => {
    const starter = STARTER_WATCHPOINTS.find((w) => w.key === 'migrations');
    if (starter === undefined) throw new Error('no migrations starter');
    return { ...starter, loudness: WatchpointLoudness.Show, ...over };
  };

  it('moves a starter unchanged since first shipped to ask and leaves an edited one, and every other watchpoint, alone', () => {
    const edited = firstShippedMigrations({ guidance: 'my own check' });
    const other = watchpoint('mine', ['**/mine/**']);
    const [unchanged, kept, untouched] = revisedWatchpoints([
      firstShippedMigrations(),
      edited,
      other,
    ]);
    expect(unchanged?.loudness).toBe(WatchpointLoudness.Ask);
    expect(kept).toEqual(edited);
    expect(untouched).toEqual(other);
  });

  it('leaves a list saved at the current revision alone, so a starter set back to show stays show', () => {
    const [kept] = revisedWatchpoints([firstShippedMigrations()], STARTER_REVISION);
    expect(kept?.loudness).toBe(WatchpointLoudness.Show);
  });
});

describe('isNoisyWatchpoint', () => {
  it('is noisy at 5 cards with at least 80% waved through, and not before', () => {
    expect(isNoisyWatchpoint({ cards: 4, waved: 4 })).toBe(false);
    expect(isNoisyWatchpoint({ cards: 6, waved: 5 })).toBe(true);
    expect(isNoisyWatchpoint({ cards: 5, waved: 3 })).toBe(false);
  });
});

describe('evalDefinitionSource', () => {
  it('shows a definition file no watchpoint covers under the evals watchpoint beside one it covers', () => {
    const evals = watchpoint('evals', ['**/evals/**']);
    const source = evalDefinitionSource(
      new Map([
        ['evals/gate.py', 'gate'],
        ['tests/llm/cases.jsonl', 'cases'],
      ]),
    );
    const hits = source([file('evals/gate.py'), file('tests/llm/cases.jsonl')], [evals], new Map());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.files.map((f) => f.path)).toEqual(['evals/gate.py', 'tests/llm/cases.jsonl']);
  });
});

describe('watchpointHitsAfter with line patterns', () => {
  it('keeps an ask file the scan never reached when its own read then shows the line', async () => {
    const patch = (path: string, body: string[]): string =>
      [
        `diff --git a/${path} b/${path}`,
        'index 1..2 100644',
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        ...body,
      ].join('\n') + '\n';
    const filler = Array.from(
      { length: 280 },
      (_, i) => `+-- harmless filler line number ${String(i)} ${'x'.repeat(48)}`,
    );
    const texts = new Map<string, string>();
    for (let i = 0; i < 29; i++) {
      const path = `db/f${String(i).padStart(2, '0')}.sql`;
      texts.set(path, patch(path, filler));
    }
    texts.set('db/m.sql', patch('db/m.sql', ['+CREATE INDEX idx_users ON users (email);']));
    const read = (only: readonly string[] | null, maxBytes: number) => {
      const buffer = Buffer.from((only ?? []).map((p) => texts.get(p) ?? '').join(''), 'utf8');
      return Promise.resolve({
        diff: buffer.subarray(0, maxBytes).toString('utf8'),
        truncated: buffer.length > maxBytes,
        files: [...texts.keys()].map((path) => ({ path, added: 1, removed: 0 })),
      });
    };
    const detail = await watchpointHitsAfter({
      watchpoints: [
        watchpoint('indexes', ['db/**'], {
          loudness: WatchpointLoudness.Ask,
          lines: ['create\\s+index'],
        }),
      ],
      head: 'abc',
      read,
      readLines: (checks) => Promise.resolve(runChecks(checks)),
    });
    const paths = detail.hits.flatMap((h) => h.files.map((f) => f.path));
    expect(paths).toContain('db/m.sql');
  });
});
