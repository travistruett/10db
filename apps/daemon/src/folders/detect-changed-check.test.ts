import { describe, expect, it } from 'vitest';
import { changedCheckFor, uiUnitOf } from './detect-changed-check';

describe('uiUnitOf', () => {
  const files = [
    'package.json',
    'amps/frontend/package.json',
    'amps/frontend/src/app/friday/page.tsx',
    'apps/desktop/package.json',
    'apps/desktop/src/views/board/board.tsx',
    'packages/ui/package.json',
  ];
  it.each([
    {
      name: 'the package holding the pages',
      globs: [['amps/frontend/src/app/friday/**']],
      expected: 'amps/frontend',
    },
    {
      name: 'the package most pages are in',
      globs: [
        ['packages/ui/src/x/**'],
        ['apps/desktop/src/views/board/**'],
        ['apps/desktop/src/views/inbox/**'],
      ],
      expected: 'apps/desktop',
    },
    {
      name: 'a literal route folder',
      globs: [['amps/frontend/src/app/[[]orgId]/**']],
      expected: 'amps/frontend',
    },
    { name: 'pages outside any package but the root', globs: [['src/app/x/**']], expected: '' },
  ])('$name', ({ globs, expected }) => {
    expect(uiUnitOf(files, globs, new Map())).toBe(expected);
  });

  it('with no page, the shallowest package with a web framework', () => {
    const packages = new Map([
      ['package.json', '{"devDependencies":{"eslint":"9.0.0"}}'],
      ['apps/desktop/package.json', '{"devDependencies":{"vite":"7.0.0"}}'],
      ['apps/desktop/e2e/fixture/package.json', '{"dependencies":{"next":"16.0.0"}}'],
      ['packages/ui/package.json', '{'],
    ]);
    expect(uiUnitOf(files, [], packages)).toBe('apps/desktop');
  });

  it('is null with no page and no web framework', () => {
    expect(uiUnitOf(files, [], new Map([['package.json', '{}']]))).toBeNull();
  });
});

describe('changedCheckFor', () => {
  const both = '{"scripts":{"typecheck":"tsc --noEmit","lint":"eslint"}}';
  it.each([
    {
      name: 'pnpm, the lockfile at the root',
      unit: 'amps/frontend',
      pkg: both,
      files: ['pnpm-lock.yaml', 'amps/frontend/package.json'],
      expected: 'pnpm --dir amps/frontend run typecheck && pnpm --dir amps/frontend run lint',
    },
    {
      name: 'the nearest lockfile wins',
      unit: 'amps/frontend',
      pkg: both,
      files: ['package-lock.json', 'amps/frontend/pnpm-lock.yaml'],
      expected: 'pnpm --dir amps/frontend run typecheck && pnpm --dir amps/frontend run lint',
    },
    {
      name: 'npm',
      unit: 'web',
      pkg: '{"scripts":{"type-check":"tsc"}}',
      files: ['web/package-lock.json'],
      expected: 'npm --prefix web run type-check',
    },
    {
      name: 'yarn, lint only',
      unit: 'web',
      pkg: '{"scripts":{"eslint":"eslint ."}}',
      files: ['yarn.lock'],
      expected: 'yarn --cwd web eslint',
    },
    {
      name: 'bun at the root',
      unit: '',
      pkg: '{"scripts":{"check-types":"tsc","lint":"x"}}',
      files: ['bun.lock'],
      expected: 'bun run --cwd . check-types && bun run --cwd . lint',
    },
    {
      name: 'a folder name that needs quoting',
      unit: 'my app',
      pkg: '{"scripts":{"tsc":"tsc"}}',
      files: ['pnpm-lock.yaml'],
      expected: "pnpm --dir 'my app' run tsc",
    },
    { name: 'no lockfile', unit: 'web', pkg: both, files: [], expected: null },
    {
      name: 'no such script',
      unit: 'web',
      pkg: '{"scripts":{"test":"vitest"}}',
      files: ['pnpm-lock.yaml'],
      expected: null,
    },
    { name: 'not JSON', unit: 'web', pkg: '{', files: ['pnpm-lock.yaml'], expected: null },
  ])('$name', ({ unit, pkg, files, expected }) => {
    expect(changedCheckFor(unit, pkg, files)?.command ?? null).toBe(expected);
  });

  it('says where it was found', () => {
    expect(
      changedCheckFor('web', '{"scripts":{"typecheck":"x","lint":"y"}}', ['pnpm-lock.yaml'])
        ?.source,
    ).toBe('from web/package.json: its typecheck and lint scripts');
  });
});
