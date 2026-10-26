import {
  chmodSync,
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
import {
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
      name: 'a link in the checkout to a protected file',
      setup: () => {
        symlinkSync(join(home, '.claude.json'), join(checkout, 'link.json'));
      },
      path: () => join(checkout, 'link.json'),
      expected: 'protected',
    },
    {
      name: 'a case variant of a protected file',
      darwinOnly: true,
      path: () => '~/.CLAUDE.json',
      expected: 'protected',
    },
    {
      name: 'a decomposed spelling of a protected directory',
      darwinOnly: true,
      setup: () => mkdirSync(join(home, 'Documents', 'résumé'), { recursive: true }),
      path: () => join(home, 'Documents', 'résumé', 'x'),
      context: () => ({ protectedReads: [join(home, 'Documents', 'résumé')] }),
      expected: 'protected',
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
      expected: 'ask',
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
    { name: 'Edit', tool: 'Edit', input: { file_path: '/a' }, expected: [] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      expect(readPathsOf(row.tool, row.input)).toEqual(row.expected);
    });
  }
});

describe('writeAccess', () => {
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

  it('allows ordinary source', () => {
    expect(writeAccess('src/a.ts', context())).toEqual({
      access: 'ok',
      realPath: join(checkout, 'src', 'a.ts'),
      viaLink: false,
    });
  });
});
