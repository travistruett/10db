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
import { JudgeKind } from '@10db/contracts';
import { judgeToolUse, type FileAccessJudge } from '../guard';
import {
  fileAccessJudge,
  protectedReads,
  readAccess,
  readPathsOf,
  SYSTEM_DOC_ROOTS,
  writeAccess,
  type FileAccessContext,
  type ReadAccess,
} from './index';
import type { WriteAccess } from './file-access';

let root: string;
let home: string;
let checkout: string;
let sibling: string;
let configDir: string;
let locked: string | null = null;

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
    // The temp root and the files root, as a lane's sandbox has them.
    sandboxTemp: {
      roots: [join(root, 't'), join(root, 'run')],
      own: join(root, 't', '10db-ownabc'),
    },
    ...overrides,
  };
}

const systemDocs = (): Partial<FileAccessContext> => ({ systemDocRoots: SYSTEM_DOC_ROOTS });
const CLT = '/Library/Developer/CommandLineTools/SDKs';
const XCODE = '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs';
const isDarwin = process.platform === 'darwin';

/** A fresh home, checkout and sibling on disk; each table row starts from one. */
function setUp(): void {
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-fa-')));
  home = join(root, 'home');
  checkout = join(root, 'work', 'repo');
  sibling = join(root, 'work', 'other');
  configDir = join(home, '.claude');
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
}

function tearDown(): void {
  if (locked !== null) chmodSync(locked, 0o700);
  locked = null;
  rmSync(root, { recursive: true, force: true });
}

beforeEach(setUp);
afterEach(tearDown);

/** Each row lays out its own files on a fresh fixture. */
function eachFresh<T>(rows: readonly T[], run: (row: T) => void): void {
  for (const row of rows) {
    tearDown();
    setUp();
    run(row);
  }
}

describe('readAccess', () => {
  interface Row {
    name: string;
    darwinOnly?: boolean;
    setup?: () => void;
    path: () => string;
    context?: () => Partial<FileAccessContext>;
    /** A search or listing of the path as a directory. */
    tree?: boolean;
    expected: ReadAccess;
  }
  const judgeRows = (rows: readonly Row[]) => {
    eachFresh(
      rows.filter((row) => row.darwinOnly !== true || isDarwin),
      (row) => {
        row.setup?.();
        const path = row.path();
        const result = readAccess(path, context(row.context?.()), row.tree ?? false);
        expect.soft(result.access, `${row.name}: ${path}`).toBe(row.expected);
      },
    );
  };

  it("asks before a person's Read of the checkout's own secret, and keeps every other reach of it shut", () => {
    const onCard = () => ({
      secretFiles: [join(checkout, '.env')],
      secretsOnCard: [join(checkout, '.env')],
    });
    judgeRows([
      {
        name: "a Read of the checkout's .env where a person is in the session",
        setup: () => {
          writeFileSync(join(checkout, '.env'), 'KEY=1');
        },
        path: () => join(checkout, '.env'),
        context: onCard,
        expected: 'ask',
      },
      {
        name: "a Read of a file in the checkout's .env folder where a person is in the session",
        setup: () => {
          mkdirSync(join(checkout, '.env'));
          writeFileSync(join(checkout, '.env', 'prod'), 'KEY=1');
        },
        path: () => join(checkout, '.env', 'prod'),
        context: onCard,
        expected: 'ask',
      },
      {
        name: "a search of the checkout's .env where a person is in the session",
        setup: () => {
          mkdirSync(join(checkout, '.env'));
        },
        path: () => join(checkout, '.env'),
        context: onCard,
        tree: true,
        expected: 'protected',
      },
      {
        name: 'a search of the checkout over its .env where a person is in the session',
        setup: () => {
          writeFileSync(join(checkout, '.env'), 'KEY=1');
        },
        path: () => checkout,
        context: () => ({ ...onCard(), setupReads: [checkout] }),
        tree: true,
        expected: 'contains-protected',
      },
      {
        name: 'a .env that links to ~/.ssh where a person is in the session',
        setup: () => {
          symlinkSync(join(home, '.ssh', 'id_rsa'), join(checkout, '.env'));
        },
        path: () => join(checkout, '.env'),
        context: () => ({
          protectedReads: [join(home, '.ssh')],
          secretFiles: [join(checkout, '.env'), join(home, '.ssh', 'id_rsa')],
          secretsOnCard: [join(checkout, '.env')],
        }),
        expected: 'protected',
      },
      {
        name: "a lane's Read of the checkout's .env",
        setup: () => {
          writeFileSync(join(checkout, '.env'), 'KEY=1');
        },
        path: () => join(checkout, '.env'),
        context: () => ({ secretFiles: [join(checkout, '.env')] }),
        expected: 'protected',
      },
    ]);
  });

  it('opens a setup read under ~/.claude but nothing secret in it or beside it', () => {
    const skills = () => join(configDir, 'skills');
    const withSecret = () => ({
      setupReads: [skills()],
      secretFiles: [join(skills(), 's', '.env')],
    });
    judgeRows([
      {
        name: 'a file in a setup read',
        setup: () => {
          mkdirSync(join(skills(), 's'), { recursive: true });
          writeFileSync(join(skills(), 's', 'SKILL.md'), '');
        },
        path: () => join(skills(), 's', 'SKILL.md'),
        context: () => ({ setupReads: [skills()] }),
        expected: 'allowed',
      },
      {
        name: 'a search of a setup read',
        setup: () => mkdirSync(join(skills(), 's'), { recursive: true }),
        path: skills,
        context: () => ({ setupReads: [skills()] }),
        tree: true,
        expected: 'allowed',
      },
      {
        name: 'a secret file inside a setup read',
        setup: () => {
          mkdirSync(join(skills(), 's'), { recursive: true });
          writeFileSync(join(skills(), 's', '.env'), 'TOKEN=x');
        },
        path: () => join(skills(), 's', '.env'),
        context: withSecret,
        expected: 'protected',
      },
      {
        name: 'a search of a setup read holding a secret file',
        setup: () => {
          mkdirSync(join(skills(), 's'), { recursive: true });
          writeFileSync(join(skills(), 's', '.env'), 'TOKEN=x');
        },
        path: skills,
        context: withSecret,
        tree: true,
        expected: 'contains-protected',
      },
      {
        name: 'a file inside a secret directory in a setup read',
        setup: () => {
          mkdirSync(join(skills(), 's', '.env'), { recursive: true });
          writeFileSync(join(skills(), 's', '.env', 'prod'), 'TOKEN=x');
        },
        path: () => join(skills(), 's', '.env', 'prod'),
        context: withSecret,
        expected: 'protected',
      },
      {
        name: 'a search of a folder inside a secret directory in a setup read',
        setup: () => mkdirSync(join(skills(), 's', '.env', 'keys'), { recursive: true }),
        path: () => join(skills(), 's', '.env', 'keys'),
        context: withSecret,
        tree: true,
        expected: 'protected',
      },
      {
        name: 'a file beside a setup read in ~/.claude',
        setup: () => {
          mkdirSync(skills(), { recursive: true });
          writeFileSync(join(configDir, 'settings.json'), '{}');
        },
        path: () => join(configDir, 'settings.json'),
        context: () => ({ setupReads: [skills()] }),
        expected: 'protected',
      },
      {
        name: 'a link from a setup read to ~/.claude.json',
        setup: () => {
          mkdirSync(join(skills(), 's'), { recursive: true });
          symlinkSync(join(home, '.claude.json'), join(skills(), 's', 'x'));
        },
        path: () => join(skills(), 's', 'x'),
        context: () => ({ setupReads: [skills()] }),
        expected: 'protected',
      },
    ]);
  });

  it("closes the sandbox roots but for the session's own temp dir, which is judged as any outside path", () => {
    judgeRows([
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
        name: "an MCP server's sealed env file in the files root",
        setup: () => {
          mkdirSync(join(root, 'run'));
          writeFileSync(join(root, 'run', '10db-mcp-0123456789ab.sh'), '');
        },
        path: () => join(root, 'run', '10db-mcp-0123456789ab.sh'),
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
        name: 'a file in its own temp dir',
        setup: () => mkdirSync(join(root, 't', '10db-ownabc'), { recursive: true }),
        path: () => join(root, 't', '10db-ownabc', 'out.log'),
        expected: 'ask',
      },
    ]);
  });

  it("allows a file directly in the session's own task output directory, and asks about every lookalike", () => {
    /** Where Claude Code puts a session's background command output under the lane's temp dir. */
    const taskDir = (
      sessionId: string,
      uidDir = `claude-${String(process.getuid?.())}`,
      slug = checkout.replace(/[^a-zA-Z0-9]/g, '-'),
    ) => join(root, 't', '10db-ownabc', uidDir, slug, sessionId, 'tasks');
    judgeRows([
      {
        name: "a file in the session's own task output directory",
        setup: () => mkdirSync(taskDir('own-id'), { recursive: true }),
        path: () => join(taskDir('own-id'), 'bcjfopcut.output'),
        expected: 'allowed',
      },
      {
        name: 'a task output file that does not exist yet',
        path: () => join(taskDir('own-id'), 'later.output'),
        expected: 'allowed',
      },
      {
        name: 'a link in the checkout to a task output file',
        setup: () => {
          mkdirSync(taskDir('own-id'), { recursive: true });
          symlinkSync(taskDir('own-id'), join(checkout, 'tasks-link'));
        },
        path: () => join(checkout, 'tasks-link', 'x.output'),
        expected: 'allowed',
      },
      {
        name: "another session's task output directory",
        setup: () => mkdirSync(taskDir('other-id'), { recursive: true }),
        path: () => join(taskDir('other-id'), 'bcjfopcut.output'),
        expected: 'ask',
      },
      {
        name: 'the own task output directory without a provider session id',
        path: () => join(taskDir('own-id'), 'x.output'),
        context: () => ({ providerSessionId: null }),
        expected: 'ask',
      },
      {
        name: 'a task output directory under another uid',
        path: () => join(taskDir('own-id', 'claude-0'), 'x.output'),
        expected: 'ask',
      },
      {
        name: 'a task output directory under another checkout slug',
        path: () => join(taskDir('own-id', undefined, 'elsewhere'), 'x.output'),
        expected: 'ask',
      },
      {
        name: 'a file below the task output directory',
        path: () => join(taskDir('own-id'), 'sub', 'x.output'),
        expected: 'ask',
      },
      {
        name: 'the task output directory itself',
        path: () => taskDir('own-id'),
        expected: 'ask',
      },
      {
        name: 'a link in the task output directory to a file outside it',
        setup: () => {
          mkdirSync(taskDir('own-id'), { recursive: true });
          symlinkSync(join(sibling, 'secret'), join(taskDir('own-id'), 'link.output'));
        },
        path: () => join(taskDir('own-id'), 'link.output'),
        expected: 'ask',
      },
      {
        name: 'a .. that climbs out of the task output directory',
        setup: () => mkdirSync(taskDir('own-id'), { recursive: true }),
        path: () => `${taskDir('own-id')}/../../other-id/tasks/x.output`,
        expected: 'ask',
      },
    ]);
  });

  it("allows the session's own tool result and protects every other session's", () => {
    const own = () => join(configDir, 'projects', 'x', 'own-id', 'tool-results', 'a.txt');
    judgeRows([
      {
        name: "the session's own tool result",
        setup: () => mkdirSync(join(own(), '..'), { recursive: true }),
        path: own,
        expected: 'allowed',
      },
      {
        name: "another session's tool result",
        path: () => join(configDir, 'projects', 'x', 'other-id', 'tool-results', 'a.txt'),
        expected: 'protected',
      },
      {
        name: 'the own path without a provider session id',
        path: own,
        context: () => ({ providerSessionId: null }),
        expected: 'protected',
      },
    ]);
  });

  it('judges a path by its real path, and protects one it cannot resolve to exactly one', () => {
    judgeRows([
      {
        name: 'a file in the checkout',
        path: () => join(checkout, 'src', 'a.ts'),
        expected: 'inside',
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
        path: () => join(root, 'future', 'résumé', 'x'),
        context: () => ({ protectedReads: [join(root, 'future', 'résumé')] }),
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
      { name: 'a path through a regular file', path: () => 'src/a.ts/x', expected: 'protected' },
    ]);
    expect(readAccess('../other/secret', context()).realPath).toBe(join(sibling, 'secret'));
  });

  it('allows the system docs and SDK headers to a context that opts in, and nothing beside them', () => {
    const sdkRoot = () => ({ systemDocRoots: [join(root, 'SDKs', '*', 'usr', 'include')] });
    judgeRows([
      ...[
        '/usr/share/man/man1/ps.1',
        '/usr/share/man',
        `${CLT}/MacOSX26.2.sdk/usr/include/sys/attr.h`,
        `${CLT}/MacOSX26.2.sdk/usr/share/man/man2/setattrlist.2`,
        `${CLT}/MacOSX15.sdk/usr/include`,
        `${XCODE}/MacOSX.sdk/usr/include/stdio.h`,
        `${XCODE}/MacOSX.sdk/usr/share/man/man2/setattrlist.2`,
      ].map((path) => ({
        name: 'a system doc or its root',
        path: () => path,
        context: systemDocs,
        expected: 'allowed' as const,
      })),
      ...['/usr/share/man/man1/ps.1', `${CLT}/MacOSX26.2.sdk/usr/include/sys/attr.h`].map(
        (path) => ({
          name: 'a system doc in a context that did not opt in',
          path: () => path,
          expected: 'ask' as const,
        }),
      ),
      ...[
        '/usr/share/manual/secret',
        '/usr/share/man/../../../etc/hosts',
        '/Library/Preferences/com.apple.loginwindow.plist',
        '/Library/Developer/CommandLineTools/usr/bin/git',
        `${CLT}/MacOSX26.2.sdk/System/Library/Frameworks/Foundation.framework/Foundation.tbd`,
        CLT,
        `${CLT}/usr/include/stdio.h`,
        `${CLT}/MacOSX26.2.sdk/usr/includes/secret`,
        `${CLT}/a/b/usr/include/x.h`,
      ].map((path) => ({
        name: 'a path beside or climbing out of the system docs',
        path: () => path,
        context: systemDocs,
        expected: 'ask' as const,
      })),
      {
        name: 'a header under an SDK root that exists on this machine',
        setup: () => {
          mkdirSync(join(root, 'SDKs', 'x.sdk', 'usr', 'include'), { recursive: true });
          writeFileSync(join(root, 'SDKs', 'x.sdk', 'usr', 'include', 'a.h'), '');
        },
        path: () => `${root}/SDKs/x.sdk/usr/include/a.h`,
        context: sdkRoot,
        expected: 'allowed',
      },
      {
        name: 'an SDK header reached by a .. out of it',
        setup: () => {
          mkdirSync(join(root, 'SDKs', 'x.sdk', 'usr', 'include'), { recursive: true });
          writeFileSync(join(root, 'SDKs', 'x.sdk', 'usr', 'secret'), '');
        },
        path: () => `${root}/SDKs/x.sdk/usr/include/../secret`,
        context: sdkRoot,
        expected: 'ask',
      },
    ]);
  });
});

it('readPathsOf names each path a read tool reads', () => {
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
    expect.soft(readPathsOf(row.tool, row.input), row.name).toEqual(row.expected);
  }
});

describe('writeAccess', () => {
  interface Row {
    name: string;
    darwinOnly?: boolean;
    setup?: () => void;
    path: () => string;
    expected: WriteAccess;
    realPath?: () => string;
    viaLink?: boolean;
    /** The judge's refusal of the same path. */
    refuse?: () => string;
  }
  const judgeRows = (rows: readonly Row[]) => {
    eachFresh(
      rows.filter((row) => row.darwinOnly !== true || isDarwin),
      (row) => {
        row.setup?.();
        const path = row.path();
        const label = `${row.name}: ${path}`;
        const result = writeAccess(path, context());
        expect.soft(result.access, label).toBe(row.expected);
        if (row.realPath) expect.soft(result.realPath, label).toBe(row.realPath());
        if (row.viaLink !== undefined) expect.soft(result.viaLink, label).toBe(row.viaLink);
        if (row.refuse) {
          expect
            .soft(fileAccessJudge(context()).write(path), label)
            .toEqual({ refuse: row.refuse() });
        }
      },
    );
  };

  it('flags .git internals and protected Claude files, by their real path', () => {
    judgeRows([
      { name: '.git internals', path: () => '.git/config', expected: 'git-internal' },
      {
        name: 'a link into .git internals',
        setup: () => {
          symlinkSync(join(checkout, '.git', 'hooks', 'pre-commit'), join(checkout, 'x'));
        },
        path: () => 'x',
        expected: 'git-internal',
        realPath: () => join(checkout, '.git', 'hooks', 'pre-commit'),
        viaLink: true,
      },
      {
        name: 'a .. taken after a link into .git',
        setup: () => {
          symlinkSync(join(checkout, '.git', 'hooks'), join(checkout, 'lnk'));
        },
        path: () => `${checkout}/lnk/../config`,
        expected: 'git-internal',
        realPath: () => join(checkout, '.git', 'config'),
      },
      {
        name: 'a link to a link whose target climbs with ..',
        setup: () => {
          symlinkSync('.git/hooks', join(checkout, 'a'));
          symlinkSync('a/../config', join(checkout, 'b'));
        },
        path: () => 'b',
        expected: 'git-internal',
        realPath: () => join(checkout, '.git', 'config'),
      },
      {
        name: 'Claude settings',
        path: () => '.claude/settings.json',
        expected: 'claude-protected',
        viaLink: false,
      },
      { name: 'a shell profile', path: () => '~/.zshrc', expected: 'claude-protected' },
      {
        name: 'a case variant of a missing protected tail',
        darwinOnly: true,
        path: () => '.claude/HOOKS/new.sh',
        expected: 'claude-protected',
      },
      {
        name: 'a kernel reading through a link even when the text is protected too',
        setup: () => {
          mkdirSync(join(checkout, '.claude', 'hooks'), { recursive: true });
          mkdirSync(join(checkout, '.claude', 'skills', 'z'), { recursive: true });
          symlinkSync('../skills/z', join(checkout, '.claude', 'hooks', 'lk'));
        },
        path: () => '.claude/hooks/lk/../y',
        expected: 'claude-protected',
        viaLink: true,
        refuse: () =>
          `Edit ${join(checkout, '.claude', 'skills', 'y')} by its own path, not through a link.`,
      },
    ]);
  });

  it('refuses a path it cannot resolve to exactly one real path', () => {
    const unresolvable = (path: string) =>
      `${path} cannot be resolved to one real path; 10db refuses it.`;
    judgeRows([
      {
        name: 'a .. after a missing part, reached through a link into .git',
        setup: () => {
          symlinkSync(join(checkout, '.git', 'hooks'), join(checkout, 'lk'));
        },
        path: () => 'lk/missing/../../config',
        expected: 'unresolvable',
        refuse: () => unresolvable('lk/missing/../../config'),
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
        expected: 'unresolvable',
        refuse: () => unresolvable('lk/np/sub/../../../src/a.ts'),
      },
      { name: 'a path through a regular file', path: () => 'src/a.ts/x', expected: 'unresolvable' },
      {
        name: 'a link loop',
        setup: () => {
          symlinkSync('b', join(checkout, 'a'));
          symlinkSync('a', join(checkout, 'b'));
        },
        path: () => 'a',
        expected: 'unresolvable',
      },
    ]);
  });

  it("flags every sandbox root but the session's own temp dir: a process ledger in the files root names what the next start signals", () => {
    judgeRows([
      {
        name: 'a process ledger in the files root',
        path: () => join(root, 'run', '10db-proc-4321-0123456789ab.json'),
        expected: 'sandbox-temp',
      },
      {
        name: "another session's temp dir",
        path: () => join(root, 't', '10db-otherxyz', 'a'),
        expected: 'sandbox-temp',
      },
      { name: 'the temp root', path: () => join(root, 't'), expected: 'sandbox-temp' },
      { name: 'the files root', path: () => join(root, 'run'), expected: 'sandbox-temp' },
      {
        name: 'the temp root through a link',
        setup: () => {
          mkdirSync(join(root, 't'), { recursive: true });
          symlinkSync(join(root, 't'), join(checkout, 'tl'));
        },
        path: () => 'tl/10db-proc-4321-0123456789ab.json',
        expected: 'sandbox-temp',
      },
      {
        name: "the session's own temp dir",
        path: () => join(root, 't', '10db-ownabc', 'scratch.txt'),
        expected: 'ok',
      },
    ]);
  });

  it('writes ordinary source, through an ordinary link and past a plain ..', () => {
    judgeRows([
      {
        name: 'ordinary source',
        path: () => 'src/a.ts',
        expected: 'ok',
        realPath: () => join(checkout, 'src', 'a.ts'),
        viaLink: false,
      },
      {
        name: 'an ordinary link to a checkout directory',
        setup: () => {
          symlinkSync('src', join(checkout, 'lnk-src'));
        },
        path: () => 'lnk-src/new.ts',
        expected: 'ok',
      },
      { name: 'a plain ..', path: () => 'src/../README.md', expected: 'ok' },
    ]);
  });
});

describe('a path in the worktrees folder outside the lane’s copy', () => {
  // `checkout` is root/work/repo and its neighbour `sibling` is root/work/other: the worktrees
  // folder is root/work, as when every batch's copy lies under one project folder.
  const withFolder = () => context({ worktreeRoot: join(root, 'work') });

  it('is its own verdict, on its real path, for a file, the folder and a search of the folder', () => {
    const ctx = withFolder();
    const rows: [string, string, boolean, ReadAccess][] = [
      ['a sibling copy', join(sibling, 'secret'), false, 'outside-copy'],
      ['a file in the folder', join(root, 'work', 'src', 'a.ts'), false, 'outside-copy'],
      ['a search of the folder', join(root, 'work'), true, 'outside-copy'],
      ['a file in the copy', join(checkout, 'src', 'a.ts'), false, 'inside'],
      ['a search of the copy', checkout, true, 'inside'],
    ];
    for (const [name, path, tree, expected] of rows) {
      expect.soft(readAccess(path, ctx, tree).access, `${name}: ${path}`).toBe(expected);
    }
    symlinkSync(sibling, join(checkout, 'peer'));
    expect
      .soft(readAccess(join(checkout, 'peer', 'secret'), ctx).access, 'a link')
      .toBe('outside-copy');
    expect
      .soft(readAccess(join(sibling, 'secret'), context()).access, 'no worktrees folder known')
      .toBe('ask');
  });

  it('is refused at once by the judge, naming the copy, for Read, Grep and Glob', () => {
    const judge = fileAccessJudge(withFolder());
    const refusal = {
      refuse: `${join(root, 'work', 'src', 'a.ts')} is in the worktrees folder but outside this lane's copy. The copy is ${checkout}; build paths from it (or use relative paths), never from the worktrees folder.`,
    };
    expect(judge.read('Read', { file_path: join(root, 'work', 'src', 'a.ts') })).toEqual(refusal);
    expect(judge.read('Grep', { path: join(root, 'work', 'src', 'a.ts') })).toEqual(refusal);
    expect(
      judge.read('Glob', { pattern: '*.ts', path: join(root, 'work', 'src', 'a.ts') }),
    ).toEqual(refusal);
    expect(judge.read('Glob', { pattern: `${join(root, 'work', 'src')}/**/*.ts` })).toEqual({
      refuse: expect.stringContaining(`The copy is ${checkout}`) as string,
    });
    expect(judge.read('Read', { file_path: join(checkout, 'src', 'a.ts') })).toBe('ok');
  });
});

describe('fileAccessJudge in the guard', () => {
  const guard = (fileAccess: FileAccessJudge, toolName: string, toolInput: unknown, cwd?: string) =>
    judgeToolUse({
      judge: JudgeKind.Rules,
      coveredByAllowRule: false,
      toolName,
      toolInput,
      repoPath: checkout,
      ...(cwd === undefined ? {} : { cwd }),
      areas: [{ name: 'all', globs: ['**'] }],
      hazards: [],
      claims: [{ kind: 'area', name: 'all' }],
      readOnly: false,
      protectedPaths: [],
      fileAccess,
    });
  const overLong = 'A path over 4096 characters or 1024 parts is never judged; 10db refuses it.';

  it('denies a protected read, a .git edit, a sandbox-root write and an edit through a link, each with its reason', () => {
    const ledger = () => join(root, 'run', '10db-proc-4321-0123456789ab.json');
    const rows: {
      name: string;
      setup?: () => void;
      tool: string;
      input: () => unknown;
      reason?: () => string;
    }[] = [
      {
        name: 'a read of a protected path through a link',
        setup: () => {
          symlinkSync(join(home, '.claude.json'), join(checkout, 'link.json'));
        },
        tool: 'Read',
        input: () => ({ file_path: 'link.json' }),
        reason: () => 'link.json is a protected path; 10db never lets a lane read it.',
      },
      {
        name: 'a Glob whose literal prefix reaches a protected directory',
        tool: 'Glob',
        input: () => ({ pattern: '../../home/.claude/*' }),
      },
      {
        name: 'an edit of .git internals',
        tool: 'Edit',
        input: () => ({ file_path: '.git/config' }),
        reason: () => '.git/ internals are never edited; use the commit tool.',
      },
      {
        name: 'a write into a sandbox root',
        tool: 'Write',
        input: () => ({ file_path: ledger(), content: '{}' }),
        reason: () =>
          `${ledger()} is in one of 10db's sandbox roots, outside this session's temp dir; 10db never lets a lane write there.`,
      },
      {
        name: 'an edit into a sandbox root',
        tool: 'Edit',
        input: () => ({ file_path: ledger() }),
      },
      {
        name: 'an edit of a protected Claude file through a link',
        setup: () => {
          writeFileSync(join(checkout, '.claude', 'settings.json'), '{}');
          symlinkSync(join(checkout, '.claude', 'settings.json'), join(checkout, 'src', 's.json'));
        },
        tool: 'Edit',
        input: () => ({ file_path: 'src/s.json' }),
        reason: () =>
          `Edit ${join(checkout, '.claude', 'settings.json')} by its own path, not through a link.`,
      },
      {
        name: 'a read of a path with more than 1024 parts',
        tool: 'Read',
        input: () => ({ file_path: 'a/'.repeat(1025) }),
        reason: () => overLong,
      },
    ];
    eachFresh(rows, (row) => {
      row.setup?.();
      const verdict = guard(fileAccessJudge(context()), row.tool, row.input());
      expect.soft(verdict.decision, row.name).toBe('deny');
      if (row.reason)
        expect.soft(verdict, row.name).toEqual({ decision: 'deny', reason: row.reason() });
    });
  });

  it('lets the checkout, an unlisted path, its own temp dir and a Claude file by its own path through', () => {
    const judge = fileAccessJudge(context());
    expect.soft(guard(judge, 'Read', { file_path: 'src/a.ts' }), 'Read src/a.ts').toEqual({
      decision: 'allow',
    });
    expect.soft(guard(judge, 'Grep', { path: '../other' }), 'Grep ../other').toEqual({
      decision: 'allow',
    });
    expect.soft(judge.write(join(root, 't', '10db-ownabc', 'scratch.txt')), 'own temp').toBe('ok');
    expect.soft(judge.write('.claude/settings.json'), '.claude/settings.json').toBe('ok');
  });

  it('refuses an edit of a very long climbing path quickly', () => {
    const started = performance.now();
    const verdict = guard(fileAccessJudge(context()), 'Edit', {
      file_path: `${'../'.repeat(300000)}x`,
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(verdict).toEqual({ decision: 'deny', reason: overLong });
  });

  it('asks about a Read outside the lane, but not of its own task output', () => {
    const judge = fileAccessJudge(context());
    const slug = checkout.replace(/[^a-zA-Z0-9]/g, '-');
    const tasks = (id: string) =>
      join(root, 't', '10db-ownabc', `claude-${String(process.getuid?.())}`, slug, id, 'tasks');
    expect(judge.readAsk('Read', { file_path: join(tasks('own-id'), 'b1.output') })).toBeNull();
    expect(judge.readAsk('Read', { file_path: join(tasks('other-id'), 'b1.output') })).toContain(
      'outside the paths a lane may read without asking',
    );
    expect(judge.readAsk('Read', { file_path: join(sibling, 'secret') })).toContain('outside');
  });

  it("asks the builder before a pass's Read of the checkout's .env, and refuses it in a lane", () => {
    writeFileSync(join(checkout, '.env'), 'KEY=1');
    const secrets = { secretFiles: [join(checkout, '.env')] };
    const pass = fileAccessJudge(context({ ...secrets, secretsOnCard: [join(checkout, '.env')] }));
    expect(guard(pass, 'Read', { file_path: '.env' })).toEqual({ decision: 'allow' });
    expect(pass.readAsk('Read', { file_path: '.env' })).toBe(
      ".env holds the project's secrets, so the builder is asked before it is read.",
    );
    expect(guard(pass, 'Grep', { path: '.env', pattern: 'KEY' }).decision).toBe('deny');
    const lane = fileAccessJudge(context(secrets));
    expect(guard(lane, 'Read', { file_path: '.env' }).decision).toBe('deny');
  });

  describe('after an earlier Bash call changed directory', () => {
    // Claude Code carries a `cd` into the next call, and Grep, Glob and LS read a relative path from there.
    const secret = () => join(checkout, 'apps', 'daemon', '.env.example');
    beforeEach(() => {
      mkdirSync(join(checkout, 'apps', 'daemon'), { recursive: true });
      writeFileSync(secret(), '');
    });

    it('judges a relative path from that directory, and ~ or an absolute path as written', () => {
      const withSecret = fileAccessJudge(context({ secretFiles: [secret()] }));
      const plain = fileAccessJudge(context());
      const daemon = join(checkout, 'apps', 'daemon');
      const rows: [
        string,
        FileAccessJudge,
        string,
        unknown,
        string | undefined,
        'allow' | 'deny',
      ][] = [
        [
          'Grep naming the file there',
          withSecret,
          'Grep',
          { pattern: 'x', path: '.env.example' },
          daemon,
          'deny',
        ],
        ['LS naming the file there', withSecret, 'LS', { path: '.env.example' }, daemon, 'deny'],
        [
          'Glob naming the file there',
          withSecret,
          'Glob',
          { pattern: '.env.example' },
          daemon,
          'deny',
        ],
        [
          'Read of a relative path there',
          withSecret,
          'Read',
          { file_path: '.env.example' },
          daemon,
          'deny',
        ],
        [
          'the same Grep with no directory',
          withSecret,
          'Grep',
          { pattern: 'x', path: '.env.example' },
          undefined,
          'allow',
        ],
        [
          'the same Grep from the copy root',
          withSecret,
          'Grep',
          { pattern: 'x', path: '.env.example' },
          checkout,
          'allow',
        ],
        [
          'the same Grep from a directory that is not absolute',
          withSecret,
          'Grep',
          { pattern: 'x', path: '.env.example' },
          'apps/daemon',
          'allow',
        ],
        [
          'a protected path named from home, outside the copy',
          plain,
          'Grep',
          { pattern: 'x', path: '.claude.json' },
          home,
          'deny',
        ],
        [
          '~ from a subdirectory',
          plain,
          'Read',
          { file_path: '~/.claude.json' },
          join(checkout, 'apps'),
          'deny',
        ],
        [
          'an absolute path from a subdirectory',
          plain,
          'Read',
          { file_path: join(home, '.claude.json') },
          join(checkout, 'apps'),
          'deny',
        ],
      ];
      for (const [name, judge, tool, input, cwd, expected] of rows) {
        expect
          .soft(guard(judge, tool, input, cwd).decision, `${name}: ${String(cwd)}`)
          .toBe(expected);
      }
    });

    it('asks about, and resolves for the broker, a relative path from the directory the hook gave', () => {
      const judge = fileAccessJudge(context());
      expect(judge.readAsk('Grep', { pattern: 'x', path: 'secret' })).toBeNull();
      expect(judge.readAsk('Grep', { pattern: 'x', path: 'secret' }, sibling)).toContain('outside');
      const ctx = context({ secretFiles: [secret()] });
      expect(readAccess('.env.example', ctx, true).access).toBe('inside');
      expect(readAccess('.env.example', ctx, true, join(checkout, 'apps', 'daemon')).access).toBe(
        'protected',
      );
    });
  });

  it('refuses every climbing segment the glob engine reads as ..', () => {
    mkdirSync(join(checkout, 'src', 'deep'), { recursive: true });
    mkdirSync(join(configDir, 'projects', 'p'), { recursive: true });
    writeFileSync(join(configDir, 'projects', 'p', 's'), 'secret');
    const climb = (segment: string) =>
      `src/deep/${Array.from({ length: 4 }, () => segment).join('/')}/home/.claude/projects/*/*`;
    for (const segment of ['[.][.]', '.[.]', '[.].', '.{Z..a}.']) {
      const pattern = climb(segment);
      expect
        .soft(globSync(pattern, { cwd: checkout }), `the glob engine climbs with ${segment}`)
        .toContain(join('..', '..', 'home', '.claude', 'projects', 'p', 's'));
      expect.soft(guard(fileAccessJudge(context()), 'Glob', { pattern }), segment).toEqual({
        decision: 'deny',
        reason: '/ contains protected paths; 10db never lets a lane search or list it.',
      });
    }
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
  const alternatives = (n: number) =>
    `src/{${Array.from({ length: n }, (_, i) => `a${String(i)}`).join(',')}}/*`;

  it('refuses a pattern whose root it cannot pin below / as a search of /', () => {
    const patterns = [
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
      'src/café/*',
      '/*/x/*',
      'src/deep/{\\,.\\}../{\\,.\\}../{\\,.\\}../{\\,.\\}../home/.claude/projects/*/*',
      '.\\../q',
      '{\\,.\\}../q',
      alternatives(65),
      'src/{a,b/*',
      'src/*/../../../x',
    ];
    for (const pattern of patterns) {
      expect.soft(judge().read('Glob', { pattern }), pattern).toEqual(contains('/'));
    }
  });

  it('judges a pattern by its literal prefix', () => {
    const patterns = [
      'src/**/*.[jt]s',
      'src/**/*.{ts,tsx}',
      'src/[a-z]*/x.ts',
      'src/**/[!_]*.ts',
      'src/[A-Z0-9_]/x.ts',
      'src/**/?./q',
      'src/.*/q',
      'src/a b@+~%=,:-x/*.ts',
      alternatives(64),
      '{src,tests}/**/*.ts',
      'src/**/*.ts',
    ];
    for (const pattern of patterns) {
      expect.soft(judge().read('Glob', { pattern }), pattern).toBe('ok');
    }
    expect.soft(judge().read('Grep', { pattern: '.', path: 'src' }), 'Grep over src').toBe('ok');
    expect
      .soft(judge().read('Grep', { pattern: 'p', path: 'src', glob: '../../*' }), 'climbing filter')
      .toBe('ok');
    expect
      .soft(judge().read('Grep', { pattern: 'p', glob: '{*.ts,*.tsx}' }), 'braced filter')
      .toBe('ok');
  });

  it('refuses a search of home or / and a brace that climbs into a protected path', () => {
    const rows: { name: string; tool: string; input: unknown; refuse: string | RegExp }[] = [
      {
        name: 'Grep over home',
        tool: 'Grep',
        input: { pattern: '.', path: '~' },
        refuse: contains('~').refuse,
      },
      {
        name: 'Grep over /',
        tool: 'Grep',
        input: { pattern: '.', path: '/' },
        refuse: contains('/').refuse,
      },
      {
        name: 'Glob based at home',
        tool: 'Glob',
        input: { pattern: '*.json', path: '~' },
        refuse: contains('~').refuse,
      },
      { name: 'LS of home', tool: 'LS', input: { path: '~' }, refuse: contains('~').refuse },
      {
        name: 'a pattern opening with a brace',
        tool: 'Glob',
        input: { pattern: '{../../home,src}/*' },
        refuse: /contains protected paths/,
      },
      {
        name: 'a brace that expands to ..',
        tool: 'Glob',
        input: { pattern: 'src/deep/{.,.}./{.,.}./{.,.}./{.,.}./home/.claude/projects/*/*' },
        refuse:
          'src/deep/../../../../home/.claude/projects is a protected path; 10db never lets a lane read it.',
      },
    ];
    for (const row of rows) {
      const verdict = judge().read(row.tool, row.input);
      const text = verdict === 'ok' ? 'ok' : verdict.refuse;
      if (typeof row.refuse === 'string') expect.soft(text, row.name).toBe(row.refuse);
      else expect.soft(text, row.name).toMatch(row.refuse);
    }
  });

  it('judges an adversarial pattern quickly', () => {
    const patterns = [
      `${'{}'.repeat(20000)}/*`,
      `src/${'{a}'.repeat(20000)}/*`,
      `src/${'{'.repeat(5000)}a${'}'.repeat(5000)}/*`,
    ];
    for (const pattern of patterns) {
      const started = performance.now();
      const verdict = judge().read('Glob', { pattern });
      expect.soft(performance.now() - started, pattern.slice(0, 20)).toBeLessThan(100);
      expect.soft(verdict, pattern.slice(0, 20)).toEqual(contains('/'));
    }
  });
});

it('the judge turns an unexpected error into a refusal', () => {
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
