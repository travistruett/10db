import { AreaRole, setupAreasProblem, type AreaDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { rebuildAreas, type PlannedPage, type RebuildInput } from './rebuild-areas';

const FILES = [
  'web/app/layout.tsx',
  'web/app/(app)/friday/page.tsx',
  'web/app/(app)/people/page.tsx',
  'web/src/friday/book.tsx',
  'web/src/ui/button.tsx',
  'web/package.json',
  'api/main.py',
  'api/models.py',
  'README.md',
];

const FRIDAY: PlannedPage = {
  name: 'friday',
  route: '/friday',
  routeGlobs: ['web/app/(app)/friday/**'],
  takenGlobs: ['web/src/friday/**'],
};
const PEOPLE: PlannedPage = {
  name: 'people',
  route: '/people',
  routeGlobs: ['web/app/(app)/people/**'],
  takenGlobs: [],
};
const OTHERS: AreaDef[] = [
  { name: 'web', globs: ['web/*', 'web/app/*'], role: AreaRole.Shared },
  { name: 'src', globs: ['web/src/**'], role: AreaRole.Shared },
  { name: 'api', globs: ['api/**'] },
  { name: 'root', globs: ['*', '.*'], catchAll: true },
];

const input = (over: Partial<RebuildInput>): RebuildInput => ({
  files: FILES,
  existing: [{ name: 'repo', globs: ['**'] }],
  hazards: ['deps', 'migrations'],
  keep: new Map(),
  others: OTHERS,
  pages: [FRIDAY, PEOPLE],
  skipped: [],
  ...over,
});

const FRIDAY_AREA: AreaDef = {
  name: 'friday',
  globs: ['web/app/(app)/friday/**', 'web/src/friday/**'],
  role: AreaRole.Page,
  route: '/friday',
};
const PEOPLE_AREA: AreaDef = {
  name: 'people',
  globs: ['web/app/(app)/people/**'],
  role: AreaRole.Page,
  route: '/people',
};

describe('rebuildAreas', () => {
  it('replaces areas no open task names with the pages and the structure', () => {
    const result = rebuildAreas(input({}));
    expect(result.proposed).toEqual([FRIDAY_AREA, PEOPLE_AREA, ...OTHERS]);
    expect(result.kept).toEqual([]);
    expect(result.pages).toEqual([
      { name: 'friday', route: '/friday', folders: ['web/app/(app)/friday/', 'web/src/friday/'] },
      { name: 'people', route: '/people', folders: ['web/app/(app)/people/'] },
    ]);
    expect(setupAreasProblem(result.proposed, ['deps', 'migrations'])).toBeNull();
  });

  it('keeps an area open tasks name as it is, drops new areas with no role whose files it holds, and keeps shared areas and pages beside it', () => {
    const result = rebuildAreas(
      input({ keep: new Map([['repo', 'kept: 146 open tasks name it']]) }),
    );
    expect(result.proposed).toEqual([
      { name: 'repo', globs: ['**'] },
      FRIDAY_AREA,
      PEOPLE_AREA,
      OTHERS[0],
      OTHERS[1],
    ]);
    expect(result.kept).toEqual([{ name: 'repo', reason: 'kept: 146 open tasks name it' }]);
  });

  it('makes a kept area that is exactly a page’s route folder that page, its globs only growing', () => {
    const result = rebuildAreas(
      input({
        existing: [
          { name: 'fri', globs: ['web/app/(app)/friday/**'] },
          { name: 'repo', globs: ['**'] },
        ],
        keep: new Map([['fri', 'kept: 2 open tasks name it']]),
      }),
    );
    expect(result.proposed[0]).toEqual({ ...FRIDAY_AREA, name: 'fri' });
    expect(result.proposed.filter((a) => a.name === 'friday')).toEqual([]);
    expect(result.kept).toEqual([
      { name: 'fri', reason: 'kept: 2 open tasks name it; it becomes the page at /friday' },
    ]);
  });

  it('leaves out a page that would share files with a kept page, saying which', () => {
    const result = rebuildAreas(
      input({
        existing: [
          {
            name: 'week',
            globs: ['web/app/(app)/friday/**/*.tsx'],
            role: AreaRole.Page,
            route: '/w',
          },
        ],
        keep: new Map([['week', 'kept: 1 open task names it']]),
      }),
    );
    expect(result.proposed.map((a) => a.name)).not.toContain('friday');
    expect(result.skipped).toContainEqual({
      name: 'friday',
      reason: 'It would share files with the kept page "week"',
    });
  });

  it('drops the code a page would take from a kept page, keeping the page', () => {
    const result = rebuildAreas(
      input({
        existing: [
          { name: 'books', globs: ['web/src/friday/**'], role: AreaRole.Page, route: '/b' },
        ],
        keep: new Map([['books', 'kept: 1 open task names it']]),
      }),
    );
    expect(result.proposed.find((a) => a.name === 'friday')).toEqual({
      name: 'friday',
      globs: ['web/app/(app)/friday/**'],
      role: AreaRole.Page,
      route: '/friday',
    });
  });

  it('renames a new page or area whose name a kept area or a hazard has', () => {
    const result = rebuildAreas(
      input({
        existing: [
          { name: 'api', globs: ['api/legacy/**'] },
          { name: 'people', globs: ['docs/people/**'] },
        ],
        keep: new Map([
          ['api', 'kept: 1 open task names it'],
          ['people', 'kept: 1 open task names it'],
        ]),
        others: [...OTHERS, { name: 'deps', globs: ['web/package.json'] }],
      }),
    );
    const names = result.proposed.map((a) => a.name);
    expect(names).toEqual([
      'api',
      'people',
      'friday',
      'people-2',
      'web',
      'src',
      'api-2',
      'root',
      'deps-2',
    ]);
  });

  it('marks a new area with no role that a page overlaps shared, and drops one a page holds whole', () => {
    const result = rebuildAreas(
      input({
        others: [
          { name: 'lib', globs: ['web/src/**'] },
          { name: 'fri-folder', globs: ['web/app/(app)/friday/**'] },
          ...OTHERS.slice(2),
        ],
      }),
    );
    expect(result.proposed).toEqual([
      FRIDAY_AREA,
      PEOPLE_AREA,
      { name: 'lib', globs: ['web/src/**'], role: AreaRole.Shared },
      ...OTHERS.slice(2),
    ]);
  });

  it('takes the catch-all from the new list when a kept area is the catch-all', () => {
    const result = rebuildAreas(
      input({
        existing: [{ name: 'rest', globs: ['README.md'], catchAll: true }],
        keep: new Map([['rest', 'kept: 1 open task names it']]),
      }),
    );
    expect(result.proposed.filter((a) => a.catchAll === true).map((a) => a.name)).toEqual(['rest']);
  });

  it('drops the last page into skipped with the words the project would refuse, folding it back', () => {
    const clash: PlannedPage = {
      name: 'friday-week',
      route: '/friday/week',
      routeGlobs: ['web/app/(app)/friday/**'],
      takenGlobs: [],
    };
    const result = rebuildAreas(input({ pages: [FRIDAY, PEOPLE, clash] }));
    expect(result.pages.map((p) => p.name)).toEqual(['friday', 'people']);
    expect(result.skipped).toContainEqual({
      name: 'friday-week',
      reason: expect.stringMatching(/can share a file/u) as string,
    });
    expect(setupAreasProblem(result.proposed, [])).toBeNull();
  });

  it('proposes nothing new when the rebuilt list is the one the project has', () => {
    const existing = [FRIDAY_AREA, PEOPLE_AREA, ...OTHERS];
    const result = rebuildAreas(input({ existing: [...existing].reverse() }));
    expect(result.pages).toEqual([]);
    expect(result.proposed).toEqual([...existing].reverse());
  });
});
