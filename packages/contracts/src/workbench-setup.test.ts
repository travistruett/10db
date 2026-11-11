import { describe, expect, it } from 'vitest';
import {
  applyAreaChanges,
  AreaChangeKind,
  AreaRole,
  SettingField,
  setupAreasProblem,
  WorkbenchSetupDto,
  type AreaChange,
  type AreaDef,
} from './index';

const AREAS: AreaDef[] = [
  { name: 'friday', globs: ['app/(app)/friday/**'] },
  {
    name: 'bundle',
    globs: ['app/(app)/accounts/**', 'app/(app)/issues/**', 'app/(app)/*', 'docs/**'],
  },
  { name: 'frontend', globs: ['app/*', 'app/login/**'] },
  { name: 'people', globs: ['app/(app)/people/**'], role: AreaRole.Page, route: '/people' },
  { name: 'root', globs: ['*', '.*'], catchAll: true },
];

const UPDATE: AreaChange = {
  kind: AreaChangeKind.Update,
  sentence: 'Make `friday` a page at /friday, with `src/capture/friday-book/`',
  reason: 'Its globs are exactly the route folder of /friday',
  area: 'friday',
  route: '/friday',
  addGlobs: ['src/capture/friday-book/**'],
};
const SPLIT: AreaChange = {
  kind: AreaChangeKind.Split,
  sentence: 'Split `bundle` into the pages `accounts` and `issues`',
  reason: 'It holds the route folders of two pages',
  area: 'bundle',
  pages: [
    {
      name: 'accounts',
      globs: ['app/(app)/accounts/**'],
      role: AreaRole.Page,
      route: '/accounts',
    },
    { name: 'issues', globs: ['app/(app)/issues/**'], role: AreaRole.Page, route: '/issues' },
  ],
  remainder: { globs: ['app/(app)/*', 'docs/**'] },
};
const MARK: AreaChange = {
  kind: AreaChangeKind.MarkShared,
  sentence: 'Mark `frontend` shared',
  reason: "It holds the app's root layout",
  area: 'frontend',
};
const ADD: AreaChange = {
  kind: AreaChangeKind.Add,
  sentence: 'Add `frontend-shared` over `src/`, shared',
  reason: "The app's source folder, which pages import from",
  area: { name: 'frontend-shared', globs: ['src/**'], role: AreaRole.Shared },
};

const byName = (areas: readonly AreaDef[]) => new Map(areas.map((a) => [a.name, a]));

/** The names of the areas a change writes. */
function touched(change: AreaChange): string[] {
  switch (change.kind) {
    case AreaChangeKind.Update:
    case AreaChangeKind.MarkShared:
      return [change.area];
    case AreaChangeKind.Split:
      return [change.area, ...change.pages.map((p) => p.name)];
    case AreaChangeKind.Add:
      return [change.area.name];
  }
}

describe('applyAreaChanges', () => {
  it.each([
    {
      name: 'no change leaves the areas as they are',
      changes: [],
      expected: AREAS,
    },
    {
      name: 'an update makes the area a page with its route and adds the taken globs, keeping its name',
      changes: [UPDATE],
      expected: [
        {
          name: 'friday',
          globs: ['app/(app)/friday/**', 'src/capture/friday-book/**'],
          role: AreaRole.Page,
          route: '/friday',
        },
        ...AREAS.slice(1),
      ],
    },
    {
      name: 'a split keeps the remainder under the old name in place and adds a page per route folder after it',
      changes: [SPLIT],
      expected: [
        AREAS[0],
        { name: 'bundle', globs: ['app/(app)/*', 'docs/**'] },
        {
          name: 'accounts',
          globs: ['app/(app)/accounts/**'],
          role: AreaRole.Page,
          route: '/accounts',
        },
        { name: 'issues', globs: ['app/(app)/issues/**'], role: AreaRole.Page, route: '/issues' },
        ...AREAS.slice(2),
      ],
    },
    {
      name: 'mark shared sets the role and nothing else',
      changes: [MARK],
      expected: [
        ...AREAS.slice(0, 2),
        { name: 'frontend', globs: ['app/*', 'app/login/**'], role: AreaRole.Shared },
        ...AREAS.slice(3),
      ],
    },
    {
      name: 'an add appends the area',
      changes: [ADD],
      expected: [...AREAS, { name: 'frontend-shared', globs: ['src/**'], role: AreaRole.Shared }],
    },
  ])('$name', ({ changes, expected }) => {
    expect(applyAreaChanges(AREAS, changes)).toEqual(expected);
  });

  it('takes any subset, in any order, and each change does what it does alone', () => {
    const all = [UPDATE, SPLIT, MARK, ADD];
    const subsets = Array.from({ length: 1 << all.length }, (_, mask) =>
      all.filter((_, i) => (mask & (1 << i)) !== 0),
    );
    for (const subset of subsets) {
      const together = byName(applyAreaChanges(AREAS, subset));
      const reversed = byName(applyAreaChanges(AREAS, [...subset].reverse()));
      expect(reversed).toEqual(together);
      for (const change of subset) {
        const alone = byName(applyAreaChanges(AREAS, [change]));
        for (const name of touched(change)) expect(together.get(name)).toEqual(alone.get(name));
      }
    }
  });

  it('a split that leaves no remainder removes the old area', () => {
    const whole: AreaChange = { ...SPLIT, remainder: null };
    expect(applyAreaChanges(AREAS, [whole]).map((a) => a.name)).toEqual([
      'friday',
      'accounts',
      'issues',
      'frontend',
      'people',
      'root',
    ]);
  });

  it('passes over a change whose area has gone or whose added name is taken, and never touches the input', () => {
    const before = structuredClone(AREAS);
    const gone: AreaChange = { ...MARK, area: 'nowhere' };
    const taken: AreaChange = {
      ...ADD,
      area: { name: 'people', globs: ['x/**'], role: AreaRole.Shared },
    };
    expect(applyAreaChanges(AREAS, [gone, taken])).toEqual(AREAS);
    expect(AREAS).toEqual(before);
  });
});

describe('setupAreasProblem', () => {
  it.each([
    { name: 'a valid list', areas: AREAS, hazards: [], problem: null },
    {
      name: 'two pages that share a file',
      areas: [
        ...AREAS,
        { name: 'more', globs: ['app/(app)/people/**'], role: AreaRole.Page, route: '/more' },
      ],
      hazards: [],
      problem: /Pages "people" and "more" can share a file/u,
    },
    {
      name: 'a name a hazard has',
      areas: AREAS,
      hazards: ['friday'],
      problem: /friday/u,
    },
    {
      name: 'a glob the project refuses',
      areas: [{ name: 'up', globs: ['../x/**'] }],
      hazards: [],
      problem: /\.\./u,
    },
  ])('$name', ({ areas, hazards, problem }) => {
    const found = setupAreasProblem(areas, hazards);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });
});

describe('WorkbenchSetupDto', () => {
  it('reads every kind of change, each kind of setting and a branch note', () => {
    const dto = {
      pages: { changes: [UPDATE, SPLIT, MARK, ADD], skipped: [{ name: 'x', reason: 'why' }] },
      settings: [
        {
          field: SettingField.AppUrl,
          value: 'http://localhost:8800',
          source: 'from docker-compose.yml: proxy publishes 8800',
        },
        {
          field: SettingField.DevLoginCommand,
          value: 'make dev-login',
          source: 'from Makefile',
          note: 'checked',
        },
        { field: SettingField.ChangedCheckCommand, value: 'pnpm lint', source: 'package.json' },
        { field: SettingField.SandboxDocker, value: true, source: 'the gate calls docker' },
      ],
      branch: { branch: 'build', ahead: 39, command: 'git push origin build' },
    };
    expect(WorkbenchSetupDto.parse(dto)).toEqual(dto);
  });

  it('refuses an app address off this Mac and a branch note with nothing ahead', () => {
    const empty = { pages: { changes: [], skipped: [] }, settings: [], branch: null };
    expect(WorkbenchSetupDto.safeParse(empty).success).toBe(true);
    expect(
      WorkbenchSetupDto.safeParse({
        ...empty,
        settings: [{ field: SettingField.AppUrl, value: 'https://example.com', source: 's' }],
      }).success,
    ).toBe(false);
    expect(
      WorkbenchSetupDto.safeParse({
        ...empty,
        branch: { branch: 'build', ahead: 0, command: 'git push origin build' },
      }).success,
    ).toBe(false);
  });
});
