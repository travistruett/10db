import {
  chmodSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judgeToolUse, type FileAccessJudge } from '../guard';
import {
  fileAccessJudge,
  protectedReads,
  readAccess,
  readPathsOf,
  writeAccess,
  type FileAccessContext,
  type ReadAccess,
} from './index';

let root: string;
let home: string;
let checkout: string;
let sibling: string;
let configDir: string;
let locked: string | null;

function context(overrides: Partial<FileAccessContext> = {}): FileAccessContext {
  return {
    checkout,
    home,
    protectedReads: protectedReads({
      home,
      dataDir: join(home, 'Library', 'Application Support', '10db'),
      configDirs: [configDir],
    }),
    readList: [],
    configDir,
    providerSessionId: 'own-id',
    sandboxTemp: { root: join(root, 't'), own: join(root, 't', '10db-ownabc') },
    ...overrides,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-fa-')));
  home = join(root, 'home');
  checkout = join(root, 'work', 'repo');
  sibling = join(root, 'work', 'other');
  configDir = join(home, '.claude');
  locked = null;
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(checkout, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(checkout, '.claude'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(checkout, 'src', 'a.ts'), '');
  writeFileSync(join(checkout, '.git', 'config'), '');
  writeFileSync(join(checkout, '.git', 'hooks', 'pre-commit'), '');
  writeFileSync(join(sibling, 'secret'), '');
  writeFileSync(join(home, '.claude.json'), '{}');
  writeFileSync(join(home, '.ssh', 'id_rsa'), '');
});

afterEach(() => {
  if (locked !== null) chmodSync(locked, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('readAccess', () => {
  const own = () => join(configDir, 'projects', 'x', 'own-id', 'tool-results', 'a.txt');
  const other = () => join(configDir, 'projects', 'x', 'other-id', 'tool-results', 'a.txt');
  const rows: {
    name: string;
    darwinOnly?: boolean;
    setup?: () => void;
    path: () => string;
    context?: () => Partial<FileAccessContext>;
    expected: ReadAccess;
  }[] = [
    {
      name: 'a file in the checkout',
      path: () => join(checkout, 'src', 'a.ts'),
      expected: 'inside',
    },
    {
      name: "another session's sealed file in the sandbox temp root",
      setup: () => {
        mkdirSync(join(root, 't'));
        writeFileSync(join(root, 't', '10db-env-0123456789ab.sh'), '');
      },
      path: () => join(root, 't', '10db-env-0123456789ab.sh'),
      expected: 'protected',
    },
    {
      name: "another session's temp dir, reached through a link in the checkout",
      setup: () => {
        mkdirSync(join(root, 't', '10db-othabc'), { recursive: true });
        symlinkSync(join(root, 't', '10db-othabc'), join(checkout, 'other-temp'));
      },
      path: () => join(checkout, 'other-temp', 'cache'),
      expected: 'protected',
    },
    {
      name: 'a file in its own temp dir, judged as any path outside the checkout',
      setup: () => {
        mkdirSync(join(root, 't', '10db-ownabc'), { recursive: true });
      },
      path: () => join(root, 't', '10db-ownabc', 'out.log'),
      expected: 'ask',
    },
    {
      name: 'a link in the checkout to a protected file',
      setup: () => {
        symlinkSync(join(home, '.claude.json'), join(checkout, 'link.json'));
      },
      path: () => join(checkout, 'link.json'),
      expected: 'protected',
    },
    {
      name: 'a case variant under a protected root that does not exist yet',
      darwinOnly: true,
      path: () => join(root, 'FUTURE', 'secret', 'x'),
      context: () => ({ protectedReads: [join(root, 'future', 'secret')] }),
      expected: 'protected',
    },
    {
      name: 'a decomposed spelling under a protected root that does not exist yet',
      path: () => join(root, 'future', 're\u0301sume\u0301', 'x'),
      context: () => ({ protectedReads: [join(root, 'future', 'r\u00e9sum\u00e9')] }),
      expected: 'protected',
    },
    {
      name: 'a link whose target is climbed out of with ..',
      setup: () => {
        mkdirSync(join(configDir, 'sub'), { recursive: true });
        symlinkSync(join(configDir, 'sub'), join(checkout, 'lnk'));
      },
      path: () => `${checkout}/lnk/../x`,
      expected: 'protected',
    },
    {
      name: 'a link to a link whose target climbs with ..',
      setup: () => {
        mkdirSync(join(configDir, 'projects'), { recursive: true });
        symlinkSync(join(configDir, 'projects'), join(checkout, 'c'));
        symlinkSync('c/../x', join(checkout, 'd'));
      },
      path: () => join(checkout, 'd'),
      expected: 'protected',
    },
    {
      name: 'a link loop',
      setup: () => {
        symlinkSync('b', join(checkout, 'a'));
        symlinkSync('a', join(checkout, 'b'));
      },
      path: () => join(checkout, 'a'),
      expected: 'protected',
    },
    {
      name: 'a .. after a missing part, reached through a link',
      setup: () => {
        symlinkSync(join(configDir, 'projects'), join(checkout, 'lk'));
      },
      path: () => `${checkout}/lk/missing/../../x`,
      expected: 'protected',
    },
    {
      name: 'an ordinary link to a checkout directory',
      setup: () => {
        symlinkSync('src', join(checkout, 'lnk-src'));
      },
      path: () => join(checkout, 'lnk-src', 'a.ts'),
      expected: 'inside',
    },
    {
      name: 'a plain .. inside the checkout',
      path: () => `${checkout}/src/../src/a.ts`,
      expected: 'inside',
    },
    { name: 'a sibling by relative path', path: () => '../other/secret', expected: 'ask' },
    { name: 'a file under the home directory', path: () => '~/.ssh/id_rsa', expected: 'ask' },
    {
      name: 'a path on the read list',
      path: () => join(sibling, 'secret'),
      context: () => ({ readList: [sibling] }),
      expected: 'allowed',
    },
    {
      name: "the session's own tool result",
      setup: () => mkdirSync(join(own(), '..'), { recursive: true }),
      path: own,
      expected: 'allowed',
    },
    { name: "another session's tool result", path: other, expected: 'protected' },
    {
      name: 'the own path without a provider session id',
      path: own,
      context: () => ({ providerSessionId: null }),
      expected: 'protected',
    },
    {
      name: 'a path under an unreadable directory',
      setup: () => {
        const dir = join(checkout, 'locked');
        mkdirSync(dir);
        chmodSync(dir, 0o000);
        locked = dir;
      },
      path: () => join(checkout, 'locked', 'f'),
      expected: 'protected',
    },
    {
      name: 'a .. past an unreadable directory, reached through a link',
      setup: () => {
        mkdirSync(join(configDir, 'np', 'sub'), { recursive: true });
        symlinkSync(configDir, join(checkout, 'lk'));
        chmodSync(join(configDir, 'np'), 0o000);
        locked = join(configDir, 'np');
      },
      path: () => 'lk/np/sub/../../../src/a.ts',
      expected: 'protected',
    },
    {
      name: 'a path through a regular file',
      path: () => 'src/a.ts/x',
      expected: 'protected',
    },
  ];
  for (const row of rows) {
    it.skipIf(row.darwinOnly === true && process.platform !== 'darwin')(row.name, () => {
      row.setup?.();
      const result = readAccess(row.path(), context(row.context?.()));
      expect(result.access).toBe(row.expected);
    });
  }

  it('reports the sibling real path', () => {
    expect(readAccess('../other/secret', context()).realPath).toBe(join(sibling, 'secret'));
  });
});

describe('readPathsOf', () => {
  const rows: { name: string; tool: string; input: unknown; expected: string[] }[] = [
    { name: 'Read', tool: 'Read', input: { file_path: '/a/b' }, expected: ['/a/b'] },
    { name: 'Grep with a path', tool: 'Grep', input: { path: '../x' }, expected: ['../x'] },
    { name: 'Grep without a path', tool: 'Grep', input: { pattern: 'p' }, expected: ['.'] },
    {
      name: 'Glob with a climbing pattern',
      tool: 'Glob',
      input: { pattern: '../../x/*' },
      expected: ['.', '../../x'],
    },
    {
      name: 'Grep ignores its glob filter',
      tool: 'Grep',
      input: { path: 'src', glob: '../../*' },
      expected: ['src'],
    },
    {
      name: 'Glob with brace alternatives',
      tool: 'Glob',
      input: { pattern: '{src,tests}/**/*.ts' },
      expected: ['.', 'src', 'tests'],
    },
    { name: 'Edit', tool: 'Edit', input: { file_path: '/a' }, expected: [] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      expect(readPathsOf(row.tool, row.input)).toEqual(row.expected);
    });
  }
});

describe('writeAccess', () => {
  it.skipIf(process.platform !== 'darwin')(
    'flags a case variant of a missing protected tail',
    () => {
      expect(writeAccess('.claude/HOOKS/new.sh', context()).access).toBe('claude-protected');
    },
  );

  it('flags a .. taken after a link into .git', () => {
    symlinkSync(join(checkout, '.git', 'hooks'), join(checkout, 'lnk'));
    const result = writeAccess(`${checkout}/lnk/../config`, context());
    expect(result.access).toBe('git-internal');
    expect(result.realPath).toBe(join(checkout, '.git', 'config'));
  });

  it('flags a link to a link whose target climbs with ..', () => {
    symlinkSync('.git/hooks', join(checkout, 'a'));
    symlinkSync('a/../config', join(checkout, 'b'));
    const result = writeAccess('b', context());
    expect(result.access).toBe('git-internal');
    expect(result.realPath).toBe(join(checkout, '.git', 'config'));
  });

  it('writes through an ordinary link to a checkout directory', () => {
    symlinkSync('src', join(checkout, 'lnk-src'));
    expect(writeAccess('lnk-src/new.ts', context()).access).toBe('ok');
  });

  it('refuses a kernel reading through a link even when the text is protected too', () => {
    mkdirSync(join(checkout, '.claude', 'hooks'), { recursive: true });
    mkdirSync(join(checkout, '.claude', 'skills', 'z'), { recursive: true });
    symlinkSync('../skills/z', join(checkout, '.claude', 'hooks', 'lk'));
    const result = writeAccess('.claude/hooks/lk/../y', context());
    expect(result).toMatchObject({ access: 'claude-protected', viaLink: true });
    expect(fileAccessJudge(context()).write('.claude/hooks/lk/../y')).toEqual({
      refuse: `Edit ${join(checkout, '.claude', 'skills', 'y')} by its own path, not through a link.`,
    });
  });

  it('refuses a .. after a missing part, reached through a link into .git', () => {
    symlinkSync(join(checkout, '.git', 'hooks'), join(checkout, 'lk'));
    expect(writeAccess('lk/missing/../../config', context()).access).toBe('unresolvable');
    expect(fileAccessJudge(context()).write('lk/missing/../../config')).toEqual({
      refuse: 'lk/missing/../../config cannot be resolved to one real path; 10db refuses it.',
    });
  });

  it('refuses a .. past an unreadable directory, reached through a link', () => {
    mkdirSync(join(configDir, 'np', 'sub'), { recursive: true });
    symlinkSync(configDir, join(checkout, 'lk'));
    chmodSync(join(configDir, 'np'), 0o000);
    locked = join(configDir, 'np');
    expect(writeAccess('lk/np/sub/../../../src/a.ts', context()).access).toBe('unresolvable');
    expect(fileAccessJudge(context()).write('lk/np/sub/../../../src/a.ts')).toEqual({
      refuse: 'lk/np/sub/../../../src/a.ts cannot be resolved to one real path; 10db refuses it.',
    });
  });

  it('refuses a path through a regular file', () => {
    expect(writeAccess('src/a.ts/x', context()).access).toBe('unresolvable');
  });

  it('refuses a link loop', () => {
    symlinkSync('b', join(checkout, 'a'));
    symlinkSync('a', join(checkout, 'b'));
    expect(writeAccess('a', context()).access).toBe('unresolvable');
  });

  it('leaves a plain .. alone', () => {
    expect(writeAccess('src/../README.md', context()).access).toBe('ok');
  });

  it('flags .git internals', () => {
    expect(writeAccess('.git/config', context()).access).toBe('git-internal');
  });

  it('flags a link into .git internals', () => {
    symlinkSync(join(checkout, '.git', 'hooks', 'pre-commit'), join(checkout, 'x'));
    const result = writeAccess('x', context());
    expect(result).toEqual({
      access: 'git-internal',
      realPath: join(checkout, '.git', 'hooks', 'pre-commit'),
      viaLink: true,
    });
  });

  it('flags Claude settings', () => {
    const result = writeAccess('.claude/settings.json', context());
    expect(result.access).toBe('claude-protected');
    expect(result.viaLink).toBe(false);
  });

  it('flags a shell profile', () => {
    expect(writeAccess('~/.zshrc', context()).access).toBe('claude-protected');
  });

  it('flags the sandbox temp root: a process ledger there names what the next start signals', () => {
    const temp = join(root, 't');
    expect(writeAccess(join(temp, '10db-proc-4321-0123456789ab.json'), context()).access).toBe(
      'sandbox-temp',
    );
    expect(writeAccess(join(temp, '10db-otherxyz', 'a'), context()).access).toBe('sandbox-temp');
    expect(writeAccess(temp, context()).access).toBe('sandbox-temp');
  });

  it('flags the temp root through a link', () => {
    mkdirSync(join(root, 't'), { recursive: true });
    symlinkSync(join(root, 't'), join(checkout, 'tl'));
    expect(writeAccess('tl/10db-proc-4321-0123456789ab.json', context()).access).toBe(
      'sandbox-temp',
    );
  });

  it('allows the session’s own temp dir', () => {
    const own = join(root, 't', '10db-ownabc', 'scratch.txt');
    expect(writeAccess(own, context()).access).toBe('ok');
  });

  it('allows ordinary source', () => {
    expect(writeAccess('src/a.ts', context())).toEqual({
      access: 'ok',
      realPath: join(checkout, 'src', 'a.ts'),
      viaLink: false,
    });
  });
});

describe('fileAccessJudge in the guard', () => {
  const guard = (fileAccess: FileAccessJudge, toolName: string, toolInput: unknown) =>
    judgeToolUse({
      toolName,
      toolInput,
      repoPath: checkout,
      areas: [{ name: 'all', globs: ['**'] }],
      hazards: [],
      claims: [{ kind: 'area', name: 'all' }],
      readOnly: false,
      protectedPaths: [],
      fileAccess,
    });

  it('refuses a read of a protected path through a link', () => {
    symlinkSync(join(home, '.claude.json'), join(checkout, 'link.json'));
    const verdict = guard(fileAccessJudge(context()), 'Read', { file_path: 'link.json' });
    expect(verdict).toEqual({
      decision: 'deny',
      reason: 'link.json is a protected path; 10db never lets a lane read it.',
    });
  });

  it('lets a read of the checkout and an unlisted path through to the sandbox', () => {
    const judge = fileAccessJudge(context());
    expect(guard(judge, 'Read', { file_path: 'src/a.ts' })).toEqual({ decision: 'allow' });
    expect(guard(judge, 'Grep', { path: '../other' })).toEqual({ decision: 'allow' });
  });

  it('refuses a Glob whose literal prefix reaches a protected directory', () => {
    const verdict = guard(fileAccessJudge(context()), 'Glob', { pattern: '../../home/.claude/*' });
    expect(verdict.decision).toBe('deny');
  });

  it('refuses an edit of .git internals', () => {
    const verdict = guard(fileAccessJudge(context()), 'Edit', { file_path: '.git/config' });
    expect(verdict).toEqual({
      decision: 'deny',
      reason: '.git/ internals are never edited; use the commit tool.',
    });
  });

  it('refuses a write into the sandbox temp root with no card, but not into the session’s own temp dir', () => {
    const judge = fileAccessJudge(context());
    const ledger = join(root, 't', '10db-proc-4321-0123456789ab.json');
    expect(guard(judge, 'Write', { file_path: ledger, content: '{}' })).toEqual({
      decision: 'deny',
      reason: `${ledger} is in 10db's sandbox temp root, outside this session's temp dir; 10db never lets a lane write there.`,
    });
    expect(guard(judge, 'Edit', { file_path: ledger }).decision).toBe('deny');
    const own = join(root, 't', '10db-ownabc', 'scratch.txt');
    expect(judge.write(own)).toBe('ok');
  });

  const overLong = 'A path over 4096 characters or 1024 parts is never judged; 10db refuses it.';

  it('refuses an edit of a very long climbing path quickly', () => {
    const started = performance.now();
    const verdict = guard(fileAccessJudge(context()), 'Edit', {
      file_path: `${'../'.repeat(300000)}x`,
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(verdict).toEqual({ decision: 'deny', reason: overLong });
  });

  it('refuses a read of a path with more than 1024 parts', () => {
    const verdict = fileAccessJudge(context()).read('Read', { file_path: 'a/'.repeat(1025) });
    expect(verdict).toEqual({ refuse: overLong });
  });

  describe('patterns the glob engine climbs with', () => {
    beforeEach(() => {
      mkdirSync(join(checkout, 'src', 'deep'), { recursive: true });
      mkdirSync(join(configDir, 'projects', 'p'), { recursive: true });
      writeFileSync(join(configDir, 'projects', 'p', 's'), 'secret');
    });
    const climb = (segment: string) =>
      `src/deep/${Array.from({ length: 4 }, () => segment).join('/')}/home/.claude/projects/*/*`;
    for (const segment of ['[.][.]', '.[.]', '[.].', '.{Z..a}.']) {
      it(`refuses ${segment}`, () => {
        const pattern = climb(segment);
        expect(globSync(pattern, { cwd: checkout })).toContain(
          join('..', '..', 'home', '.claude', 'projects', 'p', 's'),
        );
        expect(guard(fileAccessJudge(context()), 'Glob', { pattern })).toEqual({
          decision: 'deny',
          reason: '/ contains protected paths; 10db never lets a lane search or list it.',
        });
      });
    }
  });

  it('refuses an edit of a protected Claude file through a link, not by its own path', () => {
    writeFileSync(join(checkout, '.claude', 'settings.json'), '{}');
    symlinkSync(join(checkout, '.claude', 'settings.json'), join(checkout, 'src', 's.json'));
    const real = join(checkout, '.claude', 'settings.json');
    expect(guard(fileAccessJudge(context()), 'Edit', { file_path: 'src/s.json' })).toEqual({
      decision: 'deny',
      reason: `Edit ${real} by its own path, not through a link.`,
    });
    expect(fileAccessJudge(context()).write('.claude/settings.json')).toBe('ok');
  });
});

describe('directory-scoped reads', () => {
  beforeEach(() => {
    mkdirSync(join(checkout, 'src', 'deep'), { recursive: true });
  });

  const judge = () => fileAccessJudge(context());
  const contains = (path: string) => ({
    refuse: `${path} contains protected paths; 10db never lets a lane search or list it.`,
  });
  const rows: {
    name: string;
    tool: string;
    input: unknown;
    expected: string | { refuse: string } | { within: string };
    /** An adversarial pattern, which must also be judged quickly. */
    timed?: true;
  }[] = [
    ...[
      '.{Z..a}./q',
      '.{Z..a}./*',
      '{Z..a}',
      '{1..2}',
      '{..}/q',
      '[.][.]/q',
      '.[.]/q',
      '[.].',
      '[--/][--/]/q',
      '@(..)/q',
      '.@(.)/q',
      '+(.).',
      '!(x)/q',
      'src/[.]*/x',
      'src/[a]/x',
      'src/[a-Z]/x',
      'src/[a-]/x',
      'src/[a/x',
      'src/a]/x',
      'src/{a,b}/[{.,a}]/x',
      'src/*/../../x',
      'src/**/../x',
      'src/caf\u00e9/*',
    ].map((pattern) => ({
      name: `refuses ${pattern} as the root`,
      tool: 'Glob',
      input: { pattern },
      expected: contains('/'),
    })),
    ...[
      'src/**/*.[jt]s',
      'src/**/*.{ts,tsx}',
      'src/[a-z]*/x.ts',
      'src/**/[!_]*.ts',
      'src/[A-Z0-9_]/x.ts',
      'src/**/?./q',
      'src/.*/q',
      'src/a b@+~%=,:-x/*.ts',
    ].map((pattern) => ({
      name: `judges ${pattern} by its prefix`,
      tool: 'Glob',
      input: { pattern },
      expected: 'ok',
    })),
    {
      name: 'Grep over home',
      tool: 'Grep',
      input: { pattern: '.', path: '~' },
      expected: contains('~'),
    },
    {
      name: 'Grep over /',
      tool: 'Grep',
      input: { pattern: '.', path: '/' },
      expected: contains('/'),
    },
    {
      name: 'Glob based at home',
      tool: 'Glob',
      input: { pattern: '*.json', path: '~' },
      expected: contains('~'),
    },
    { name: 'LS of home', tool: 'LS', input: { path: '~' }, expected: contains('~') },
    {
      name: 'Grep over a checkout subdir',
      tool: 'Grep',
      input: { pattern: '.', path: 'src' },
      expected: 'ok',
    },
    {
      name: 'absolute pattern with a leading glob',
      tool: 'Glob',
      input: { pattern: '/*/x/*' },
      expected: contains('/'),
    },
    {
      name: 'pattern opening with a brace',
      tool: 'Glob',
      input: { pattern: '{../../home,src}/*' },
      expected: { within: 'contains protected paths' },
    },
    {
      name: 'a brace that expands to ..',
      tool: 'Glob',
      input: { pattern: 'src/deep/{.,.}./{.,.}./{.,.}./{.,.}./home/.claude/projects/*/*' },
      expected: { within: 'protected path' },
    },
    {
      name: 'a brace that expands to .., by its exact refusal',
      tool: 'Glob',
      input: { pattern: 'src/deep/{.,.}./{.,.}./{.,.}./{.,.}./home/.claude/projects/*/*' },
      expected:
        'src/deep/../../../../home/.claude/projects is a protected path; 10db never lets a lane read it.',
    },
    {
      name: 'an escaped comma and dot that climb',
      tool: 'Glob',
      input: {
        pattern: 'src/deep/{\\,.\\}../{\\,.\\}../{\\,.\\}../{\\,.\\}../home/.claude/projects/*/*',
      },
      expected: contains('/'),
    },
    {
      name: 'an escaped dot that climbs',
      tool: 'Glob',
      input: { pattern: '.\\../q' },
      expected: contains('/'),
    },
    {
      name: 'a braced escape that climbs',
      tool: 'Glob',
      input: { pattern: '{\\,.\\}../q' },
      expected: contains('/'),
    },
    {
      name: 'exactly the cap of alternatives',
      tool: 'Glob',
      input: {
        pattern: `src/{${Array.from({ length: 64 }, (_, i) => `a${String(i)}`).join(',')}}/*`,
      },
      expected: 'ok',
    },
    {
      name: 'twenty thousand empty braces',
      tool: 'Glob',
      timed: true,
      input: { pattern: `${'{}'.repeat(20000)}/*` },
      expected: contains('/'),
    },
    {
      name: 'twenty thousand single braces',
      tool: 'Glob',
      timed: true,
      input: { pattern: `src/${'{a}'.repeat(20000)}/*` },
      expected: contains('/'),
    },
    {
      name: 'five thousand nested braces',
      tool: 'Glob',
      timed: true,
      input: { pattern: `src/${'{'.repeat(5000)}a${'}'.repeat(5000)}/*` },
      expected: contains('/'),
    },
    {
      name: 'braced directories',
      tool: 'Glob',
      input: { pattern: '{src,tests}/**/*.ts' },
      expected: 'ok',
    },
    {
      name: 'more alternatives than the cap',
      tool: 'Glob',
      input: {
        pattern: `src/{${Array.from({ length: 65 }, (_, i) => `a${String(i)}`).join(',')}}/*`,
      },
      expected: contains('/'),
    },
    {
      name: 'an unbalanced brace',
      tool: 'Glob',
      input: { pattern: 'src/{a,b/*' },
      expected: contains('/'),
    },
    {
      name: 'a Grep glob filter that climbs',
      tool: 'Grep',
      input: { pattern: 'p', path: 'src', glob: '../../*' },
      expected: 'ok',
    },
    {
      name: 'a braced Grep glob filter',
      tool: 'Grep',
      input: { pattern: 'p', glob: '{*.ts,*.tsx}' },
      expected: 'ok',
    },
    {
      name: 'pattern climbing after a glob',
      tool: 'Glob',
      input: { pattern: 'src/*/../../../x' },
      expected: contains('/'),
    },
    { name: 'ordinary pattern', tool: 'Glob', input: { pattern: 'src/**/*.ts' }, expected: 'ok' },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const started = performance.now();
      const verdict = judge().read(row.tool, row.input);
      if (row.timed) expect(performance.now() - started).toBeLessThan(100);
      if (typeof row.expected === 'string' && row.expected !== 'ok') {
        expect(verdict).toEqual({ refuse: row.expected });
      } else if (typeof row.expected === 'object' && 'within' in row.expected) {
        expect(verdict === 'ok' ? 'ok' : verdict.refuse).toContain(row.expected.within);
      } else {
        expect(verdict).toEqual(row.expected);
      }
    });
  }
});

describe('the judge at its boundary', () => {
  it('turns an unexpected error into a refusal', () => {
    const broken = {
      ...context(),
      get checkout(): string {
        throw new Error('boom');
      },
    };
    const judge = fileAccessJudge(broken);
    expect(judge.read('Read', { file_path: 'src/a.ts' })).toEqual({
      refuse: 'src/a.ts could not be judged; 10db refuses it.',
    });
    expect(judge.write('src/a.ts')).toEqual({
      refuse: 'src/a.ts could not be judged; 10db refuses it.',
    });
  });
});

describe('fileAccessJudge asks', () => {
  it.each([
    [
      'a read of a file under the home directory',
      'Read',
      { file_path: '~/.aws/credentials' },
      true,
    ],
    ['a read of a file in the checkout', 'Read', { file_path: 'src/a.ts' }, false],
    ['a search of a sibling directory', 'Grep', { pattern: 'x', path: '../other' }, true],
  ])('readAsk: %s', (_name, toolName, input, asks) => {
    const reason = fileAccessJudge(context()).readAsk(toolName, input);
    expect(reason !== null).toBe(asks);
  });

  it.each([
    ['a file under .claude', '.claude/hooks/new.sh', true],
    ['a file in the home directory shell setup', '~/.zshrc', true],
    ['a source file', 'src/a.ts', false],
  ])('writeAsk: %s', (_name, path, asks) => {
    expect(fileAccessJudge(context()).writeAsk(path) !== null).toBe(asks);
  });
});
