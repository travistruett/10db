import { describe, expect, it } from 'vitest';
import {
  importBindings,
  importSpecifiers,
  NO_ALIASES,
  readPathAliases,
  resolveImport,
} from './import-graph';

describe('importSpecifiers', () => {
  it.each([
    { name: 'a default import', text: `import X from './x';`, found: ['./x'] },
    {
      name: 'named imports over several lines, and a type import',
      text: `import {\n  a,\n  b as c,\n} from "@/src/y";\nimport type { T } from '../t';`,
      found: ['@/src/y', '../t'],
    },
    { name: 'a namespace import', text: `import * as all from './all'`, found: ['./all'] },
    { name: 'an import for its effect', text: `import './styles.css';`, found: ['./styles.css'] },
    {
      name: 'a re-export',
      text: `export * from './a';\nexport { b } from './b';\nexport type { C } from './c';`,
      found: ['./a', './b', './c'],
    },
    {
      name: 'a dynamic import and a require with a literal',
      text: `const L = lazy(() => import('./lazy'));\nconst r = require("./req");`,
      found: ['./lazy', './req'],
    },
    {
      name: 'a dynamic import or require of an expression',
      text: 'import(name); require(`./${x}`);',
      found: [],
    },
    {
      name: 'an export that is no re-export',
      text: `export const x = 1;\nexport function f() {}\nconst y = "from './nowhere'";`,
      found: [],
    },
    {
      name: 'imports in comments and strings, and a method named import',
      text: `// import a from './a'\n/* import('./b') */\nconst s = "import c from './c'";\nloader.import('./d');`,
      found: [],
    },
    {
      name: 'an apostrophe in JSX text hides no later import',
      text: `const t = <p>Don't panic</p>;\nconst L = lazy(() => import('./lazy'));`,
      found: ['./lazy'],
    },
  ])('$name', ({ text, found }) => {
    expect(importSpecifiers(text)).toEqual(found);
  });

  it.each([
    { name: 'an import with no from', text: `import ${'a '.repeat(100_000)}` },
    { name: 'an export with no from', text: `export { ${'a, '.repeat(70_000)}` },
    { name: 'a run of import words', text: 'import '.repeat(30_000) },
  ])('reads $name of some 200 KB in linear time', ({ text }) => {
    const started = performance.now();
    expect(importSpecifiers(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('importBindings', () => {
  it('names each local an import binds, with its specifier', () => {
    expect(
      importBindings(
        `import Board, { InboxView as Inbox, type T, people } from './views';\nimport * as all from './all';\nimport './side';`,
      ),
    ).toEqual([
      { specifier: './views', locals: ['Board', 'Inbox', 'T', 'people'] },
      { specifier: './all', locals: ['all'] },
      { specifier: './side', locals: [] },
    ]);
  });
});

describe('readPathAliases', () => {
  it.each([
    {
      name: 'paths with no baseUrl are relative to the config',
      config: { path: 'web/tsconfig.json', text: '{"compilerOptions":{"paths":{"@/*":["./*"]}}}' },
      specifier: '@/src/x',
      resolved: 'web/src/x.ts',
    },
    {
      name: 'comments, a /* inside a string and trailing commas are read as tsconfig reads them',
      config: {
        path: 'web/tsconfig.json',
        text: `{
          // the app
          "compilerOptions": {
            /* aliases */
            "paths": { "@/*": ["./*",], },
          },
        }`,
      },
      specifier: '@/src/x',
      resolved: 'web/src/x.ts',
    },
    {
      name: 'paths under a baseUrl',
      config: {
        path: 'web/jsconfig.json',
        text: '{"compilerOptions":{"baseUrl":"src","paths":{"~/*":["lib/*"]}}}',
      },
      specifier: '~/y',
      resolved: 'web/src/lib/y.tsx',
    },
    {
      name: 'a baseUrl alone resolves a bare name to a tracked file',
      config: { path: 'web/tsconfig.json', text: '{"compilerOptions":{"baseUrl":"src"}}' },
      specifier: 'lib/y',
      resolved: 'web/src/lib/y.tsx',
    },
    {
      name: 'an exact alias',
      config: {
        path: 'web/tsconfig.json',
        text: '{"compilerOptions":{"paths":{"config":["./src/x.ts"]}}}',
      },
      specifier: 'config',
      resolved: 'web/src/x.ts',
    },
    {
      name: 'a $ pattern in the matched part is taken as written',
      config: { path: 'web/tsconfig.json', text: '{"compilerOptions":{"paths":{"@/*":["./*"]}}}' },
      specifier: '@/src/$&',
      resolved: 'web/src/$&.ts',
    },
    {
      name: 'an unreadable config has no aliases',
      config: { path: 'web/tsconfig.json', text: '{ "compilerOptions": ' },
      specifier: '@/src/x',
      resolved: null,
    },
    {
      name: 'a config of the wrong shape has no aliases',
      config: { path: 'web/tsconfig.json', text: '{"compilerOptions":{"paths":["@/*"]}}' },
      specifier: '@/src/x',
      resolved: null,
    },
  ])('$name', ({ config, specifier, resolved }) => {
    const tracked = new Set(['web/src/x.ts', 'web/src/lib/y.tsx', 'web/src/$&.ts']);
    expect(resolveImport('web/app/page.tsx', specifier, readPathAliases(config), tracked)).toBe(
      resolved,
    );
  });
});

describe('resolveImport', () => {
  const tracked = new Set([
    'web/app/page.tsx',
    'web/app/util.ts',
    'web/src/feature/index.ts',
    'web/src/esm.ts',
    'web/src/plain.js',
    'web/src/data.json',
  ]);
  it.each([
    {
      name: 'a relative file with its extension found',
      specifier: './util',
      resolved: 'web/app/util.ts',
    },
    {
      name: 'a folder by its index',
      specifier: '../src/feature',
      resolved: 'web/src/feature/index.ts',
    },
    {
      name: 'an ESM .js name of a .ts file',
      specifier: '../src/esm.js',
      resolved: 'web/src/esm.ts',
    },
    { name: 'a file named in full', specifier: '../src/plain.js', resolved: 'web/src/plain.js' },
    { name: 'a file that is no source file', specifier: '../src/data.json', resolved: null },
    { name: 'a package', specifier: 'react', resolved: null },
    { name: 'a path that leaves the repository', specifier: '../../../x', resolved: null },
    { name: 'a file that is not tracked', specifier: './gone', resolved: null },
  ])('$name', ({ specifier, resolved }) => {
    expect(resolveImport('web/app/page.tsx', specifier, NO_ALIASES, tracked)).toBe(resolved);
  });
});
