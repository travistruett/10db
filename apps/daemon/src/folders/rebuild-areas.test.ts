import { AreaRole, setupAreasProblem, withoutPages, type AreaDef } from '@10db/contracts';
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

  it('gives a new page the label its nav guesses, in the area and in its row', () => {
    const result = rebuildAreas(input({ pages: [{ ...FRIDAY, label: 'Weekly' }, PEOPLE] }));
    expect(result.proposed[0]).toEqual({ ...FRIDAY_AREA, label: 'Weekly' });
    expect(result.proposed[1]).toEqual(PEOPLE_AREA);
    expect(result.pages.map((p) => p.label)).toEqual(['Weekly', undefined]);
  });

  describe('a project that already has the pages', () => {
    const existing = (people: Partial<AreaDef> = {}): AreaDef[] => [
      FRIDAY_AREA,
      { ...PEOPLE_AREA, ...people },
      ...OTHERS,
    ];

    it.each<{
      name: string;
      have: Partial<AreaDef>;
      guess: string | undefined;
      label: string | undefined;
    }>([
      { name: 'an unlabelled page takes the guess', have: {}, guess: 'Team', label: 'Team' },
      {
        name: 'a label the builder set beats the guess',
        have: { label: 'Folks' },
        guess: 'Team',
        label: 'Folks',
      },
      { name: 'no guess leaves the page unlabelled', have: {}, guess: undefined, label: undefined },
    ])('$name, and is offered as a rebuild but never as a new page', ({ have, guess, label }) => {
      const result = rebuildAreas(
        input({
          existing: existing(have),
          pages: [FRIDAY, { ...PEOPLE, ...(guess === undefined ? {} : { label: guess }) }],
        }),
      );
      expect(result.pages).toEqual([]);
      const people = result.proposed.find((a) => a.name === 'people');
      expect(people?.label).toBe(label);
      expect(result.skipped).toEqual([]);
    });

    it('offers the rebuild when only a label differs, and nothing when the label already matches', () => {
      const labelled = existing({ label: 'Team' });
      const same = rebuildAreas(
        input({ existing: labelled, pages: [FRIDAY, { ...PEOPLE, label: 'Team' }] }),
      );
      expect(same.proposed).toEqual(labelled);
      const added = rebuildAreas(
        input({ existing: existing(), pages: [FRIDAY, { ...PEOPLE, label: 'Team' }] }),
      );
      expect(added.proposed).toEqual(labelled);
      expect(added.proposed).not.toEqual(existing());
    });

    it('gives a kept page area with no label the guess, and leaves a labelled one alone', () => {
      const kept = rebuildAreas(
        input({
          existing: existing(),
          keep: new Map([['people', 'kept: 2 open tasks name it']]),
          pages: [FRIDAY, { ...PEOPLE, label: 'Team' }],
        }),
      );
      expect(kept.proposed.find((a) => a.name === 'people')?.label).toBe('Team');
      const own = rebuildAreas(
        input({
          existing: existing({ label: 'Folks' }),
          keep: new Map([['people', 'kept: 2 open tasks name it']]),
          pages: [FRIDAY, { ...PEOPLE, label: 'Team' }],
        }),
      );
      expect(own.proposed.find((a) => a.name === 'people')?.label).toBe('Folks');
    });
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

  it('unticking a kept area that became a page puts it back exactly, never folding it away', () => {
    const fri: AreaDef = { name: 'fri', globs: ['web/app/(app)/friday/**'], catchAll: false };
    const result = rebuildAreas(
      input({
        existing: [fri, { name: 'repo', globs: ['**'] }],
        keep: new Map([['fri', 'kept: 2 open tasks name it']]),
      }),
    );
    expect(result.pages.find((p) => p.name === 'fri')?.was).toEqual(fri);
    const unticked = withoutPages(result.proposed, ['fri'], result.pages);
    expect(unticked.find((a) => a.name === 'fri')).toEqual(fri);
    expect(setupAreasProblem(unticked, [])).toBeNull();
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

  it('answers the project’s own list when the rebuild finds no page', () => {
    const existing = [{ name: 'repo', globs: ['**'] }];
    const result = rebuildAreas(input({ existing, pages: [] }));
    expect(result.proposed).toEqual(existing);
    expect(result.pages).toEqual([]);
  });

  it('proposes nothing new when the rebuilt list is the one the project has', () => {
    const existing = [FRIDAY_AREA, PEOPLE_AREA, ...OTHERS];
    const result = rebuildAreas(input({ existing: [...existing].reverse() }));
    expect(result.pages).toEqual([]);
    expect(result.proposed).toEqual([...existing].reverse());
  });
});
