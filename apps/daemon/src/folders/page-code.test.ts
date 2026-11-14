import { describe, expect, it } from 'vitest';
import { NO_ALIASES, readPathAliases, type PathAliases } from './import-graph';
import { PAGE_CODE_MAX_FILES, pageCode, type PageSeed } from './page-code';

const ALIASES = readPathAliases({
  path: 'web/tsconfig.json',
  text: '{"compilerOptions":{"paths":{"@/*":["./*"]}}}',
});

const FRIDAY: PageSeed = { name: 'friday', folder: 'web/app/(app)/friday' };
const PEOPLE: PageSeed = { name: 'people', folder: 'web/app/(app)/people' };

interface Row {
  readonly name: string;
  /** Each tracked file and what it holds; a file with no text is not source or was not read. */
  readonly repo: Readonly<Record<string, string>>;
  readonly pages?: readonly PageSeed[];
  readonly sharedRoots?: readonly string[];
  readonly aliases?: PathAliases;
  readonly taken: Readonly<Record<string, readonly string[]>>;
}

const run = (row: Row) => {
  const files = Object.keys(row.repo);
  return pageCode({
    unit: 'web',
    files,
    texts: new Map(Object.entries(row.repo).filter(([path]) => /\.[jt]sx?$/u.test(path))),
    aliases: row.aliases ?? ALIASES,
    pages: row.pages ?? [FRIDAY, PEOPLE],
    sharedRoots: row.sharedRoots ?? [],
  });
};

describe('pageCode', () => {
  it.each<Row>([
    {
      name: 'a shell route takes the feature folder it alone imports, its tests and styles with it',
      repo: {
        'web/app/(app)/friday/page.tsx': `import { Book } from "@/src/capture/friday-book/workspace";`,
        'web/src/capture/friday-book/workspace.tsx': `import { start } from './session';`,
        'web/src/capture/friday-book/session.ts': '',
        'web/src/capture/friday-book/session.test.ts': `import { start } from './session';`,
        'web/src/capture/friday-book/workspace.module.css': '',
        'web/src/capture/notes.tsx': '',
        'web/app/(app)/people/page.tsx': `import '@/src/capture/notes';`,
      },
      taken: { friday: ['web/src/capture/friday-book/**'], people: ['web/src/capture/notes.tsx'] },
    },
    {
      name: 'a component two pages import is neither page’s, so its folder stays shared',
      repo: {
        'web/app/(app)/friday/page.tsx': `import { Button } from '../../../src/ui/button';`,
        'web/app/(app)/people/page.tsx': `import { Button } from '@/src/ui/button';`,
        'web/src/ui/button.tsx': '',
        'web/src/ui/card.tsx': '',
      },
      taken: {},
    },
    {
      name: 'a folder holding a file no page reaches is not swept in: the page takes its files alone',
      repo: {
        'web/app/(app)/people/page.tsx': `import { Table } from '@/src/people/table';`,
        'web/src/people/table.tsx': '',
        'web/src/people/old-table.tsx': '',
        'web/app/(app)/friday/page.tsx': `import '@/src/other/x';`,
        'web/src/other/x.ts': '',
        'web/src/other/x.test.ts': `import './x';`,
      },
      taken: { people: ['web/src/people/table.tsx'], friday: ['web/src/other/**'] },
    },
    {
      name: 'a folder index, a dynamic import and a re-export are followed',
      repo: {
        'web/app/(app)/friday/page.tsx': `const L = lazy(() => import('@/src/friday'));`,
        'web/src/friday/index.ts': `export * from './view';`,
        'web/src/friday/view.tsx': `import '../deep/part';`,
        'web/src/deep/part.ts': '',
        'web/src/deep/people-part.ts': '',
        'web/app/(app)/people/page.tsx': `import '@/src/deep/people-part';`,
      },
      taken: {
        friday: ['web/src/friday/**', 'web/src/deep/part.ts'],
        people: ['web/src/deep/people-part.ts'],
      },
    },
    {
      name: 'an alias under a baseUrl',
      repo: {
        'web/app/(app)/friday/page.tsx': `import { F } from '~/friday/f';`,
        'web/src/lib/friday/f.ts': '',
        'web/src/lib/other.ts': `import './friday/f';`,
        'web/app/(app)/people/page.tsx': `import '~/other';`,
      },
      aliases: readPathAliases({
        path: 'web/tsconfig.json',
        text: '{"compilerOptions":{"baseUrl":"src","paths":{"~/*":["lib/*"]}}}',
      }),
      taken: { people: ['web/src/lib/other.ts'] },
    },
    {
      name: 'what the root layout reaches is shared, even when one page reaches it too',
      repo: {
        'web/app/layout.tsx': `import '@/src/shell/frame';`,
        'web/src/shell/frame.tsx': '',
        'web/app/(app)/friday/page.tsx': `import '@/src/shell/frame';`,
      },
      sharedRoots: ['web/app/layout.tsx'],
      taken: {},
    },
    {
      name: 'a folder holding another page’s route folder is not taken',
      repo: {
        'web/app/(app)/friday/page.tsx': `import '../_parts/friday-bit';`,
        'web/app/(app)/_parts/friday-bit.tsx': '',
        'web/app/(app)/people/page.tsx': '',
      },
      taken: { friday: ['web/app/(app)/_parts/**'] },
    },
    {
      name: 'the unit’s own root is never taken',
      repo: {
        'web/app/(app)/friday/page.tsx': `import '../../../friday-root';`,
        'web/friday-root.ts': '',
      },
      pages: [FRIDAY],
      taken: { friday: ['web/friday-root.ts'] },
    },
    {
      name: 'a page keeps 20 or more single files shared',
      repo: {
        'web/app/(app)/friday/page.tsx': Array.from(
          { length: 20 },
          (_, i) => `import '@/src/mixed/f${String(i)}';`,
        ).join('\n'),
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`web/src/mixed/f${String(i)}.ts`, '']),
        ),
        'web/src/mixed/both.ts': '',
        'web/app/(app)/people/page.tsx': `import '@/src/mixed/both';`,
      },
      taken: { people: ['web/src/mixed/both.ts'] },
    },
    {
      name: 'what only a test in the route folder imports is no page’s',
      repo: {
        'web/app/(app)/friday/page.tsx': `import '@/src/ui/button';`,
        'web/app/(app)/friday/page.test.tsx': `import '@/src/test/friday-fixtures';`,
        'web/src/test/friday-fixtures.ts': '',
        'web/src/ui/button.tsx': '',
        'web/app/(app)/people/page.tsx': `import '@/src/ui/button';`,
      },
      taken: {},
    },
    {
      name: 'an index page reaches from its own file: what only it imports beside it, and its folders',
      repo: {
        'web/app/(app)/layout.tsx': `import './shell';`,
        'web/app/(app)/shell.tsx': '',
        'web/app/(app)/page.tsx': `import './home-picker';\nimport '@/src/home/board';`,
        'web/app/(app)/home-picker.tsx': `import './shell';`,
        'web/src/home/board.tsx': '',
        'web/app/(app)/friday/page.tsx': `import '@/src/ui/x';`,
        'web/src/ui/x.ts': '',
      },
      pages: [{ name: 'home', files: ['web/app/(app)/page.tsx'] }, FRIDAY],
      sharedRoots: ['web/app/(app)/layout.tsx'],
      taken: {
        home: ['web/src/home/**', 'web/app/(app)/page.tsx', 'web/app/(app)/home-picker.tsx'],
        friday: ['web/src/ui/**'],
      },
    },
    {
      name: 'what a router reaches outside the route components is shared, and it never enters them',
      repo: {
        'web/src/router.tsx': `import './shell/frame';\nimport './views/board/board-view';\nimport './views/inbox/inbox-view';`,
        'web/src/shell/frame.tsx': `import '../lib/menu';`,
        'web/src/lib/menu.tsx': '',
        'web/src/views/board/board-view.tsx': `import '../../board-bits/card';\nimport '../../lib/menu';`,
        'web/src/board-bits/card.tsx': '',
        'web/src/views/inbox/inbox-view.tsx': '',
      },
      pages: [
        { name: 'board', folder: 'web/src/views/board' },
        { name: 'inbox', folder: 'web/src/views/inbox' },
      ],
      sharedRoots: ['web/src/router.tsx'],
      taken: { board: ['web/src/board-bits/**'] },
    },
    {
      name: 'a page that imports nothing takes nothing',
      repo: { 'web/app/(app)/friday/page.tsx': '', 'web/src/x.ts': '' },
      aliases: NO_ALIASES,
      taken: {},
    },
  ])('$name', (row) => {
    const result = run(row);
    expect(result.note).toBeNull();
    expect(Object.fromEntries(result.taken)).toEqual(row.taken);
  });

  it('takes the dotfile companions of a folder it takes', () => {
    const result = run({
      name: 'dotfiles',
      repo: {
        'web/app/(app)/friday/page.tsx': `import '@/src/friday/view';`,
        'web/src/friday/view.tsx': '',
        'web/src/friday/.eslintrc': '',
        'web/app/(app)/people/page.tsx': `import '@/src/other';`,
        'web/src/other.ts': '',
      },
      taken: {},
    });
    expect(result.taken.get('friday')).toEqual(['web/src/friday/**', 'web/src/friday/**/.*']);
  });

  it('builds no graph over more source files than the cap, and says so', () => {
    const many = Object.fromEntries(
      Array.from({ length: PAGE_CODE_MAX_FILES + 1 }, (_, i) => [`web/src/f${String(i)}.ts`, '']),
    );
    const result = run({
      name: 'too many',
      repo: { 'web/app/(app)/friday/page.tsx': `import '@/src/f1';`, ...many },
      taken: {},
    });
    expect(result.taken.size).toBe(0);
    expect(result.note).toMatch(/5,000/u);
  });
});
