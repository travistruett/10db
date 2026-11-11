import { describe, expect, it } from 'vitest';
import {
  AreaRole,
  SettingField,
  setupAreasProblem,
  WorkbenchSetupDto,
  withoutPages,
  type AreaDef,
} from './index';

const PROPOSED: AreaDef[] = [
  {
    name: 'friday',
    globs: ['app/(app)/friday/**', 'src/capture/friday/**'],
    role: AreaRole.Page,
    route: '/friday',
  },
  { name: 'board', globs: ['src/views/board/**'], role: AreaRole.Page, route: '/board' },
  { name: 'web-shared', globs: ['src/**', 'src/**/.*'], role: AreaRole.Shared },
  { name: 'docs', globs: ['docs/**'] },
  { name: 'root', globs: ['*', '.*'], catchAll: true },
];

describe('withoutPages', () => {
  it.each([
    { name: 'nothing unticked leaves the list as it is', unticked: [], expected: PROPOSED },
    {
      name: 'an unticked page keeps its route folder as an area with no role, its shared code folded back',
      unticked: ['friday'],
      expected: [{ name: 'friday', globs: ['app/(app)/friday/**'] }, ...PROPOSED.slice(1)],
    },
    {
      name: 'an unticked page a shared area holds whole goes',
      unticked: ['board'],
      expected: [PROPOSED[0], ...PROPOSED.slice(2)],
    },
    {
      name: 'a name that is no page is passed over',
      unticked: ['docs', 'web-shared', 'nowhere'],
      expected: PROPOSED,
    },
  ])('$name', ({ unticked, expected }) => {
    const before = structuredClone(PROPOSED);
    expect(withoutPages(PROPOSED, unticked)).toEqual(expected);
    expect(PROPOSED).toEqual(before);
  });

  it('gives each page alone the same result whatever else is unticked', () => {
    const both = withoutPages(PROPOSED, ['friday', 'board']);
    expect(both).toEqual(withoutPages(withoutPages(PROPOSED, ['board']), ['friday']));
    expect(setupAreasProblem(both, [])).toBeNull();
  });
});

describe('setupAreasProblem', () => {
  it.each([
    { name: 'a valid list', areas: PROPOSED, hazards: [], problem: null },
    {
      name: 'two pages that share a file',
      areas: [
        ...PROPOSED,
        { name: 'more', globs: ['app/(app)/friday/x/**'], role: AreaRole.Page, route: '/more' },
      ],
      hazards: [],
      problem: /Pages "friday" and "more" can share a file/u,
    },
    {
      name: 'a name a hazard has',
      areas: PROPOSED,
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
      areas: {
        proposed: PROPOSED,
        kept: [{ name: 'root', reason: 'kept: 3 open tasks name it' }],
        pages: [
          {
            name: 'friday',
            route: '/friday',
            folders: ['app/(app)/friday/', 'src/capture/friday/'],
          },
          { name: 'board', folders: ['src/views/board/'] },
        ],
        skipped: [{ name: 'x', reason: 'why' }],
      },
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
    const empty = {
      areas: { proposed: [], kept: [], pages: [], skipped: [] },
      settings: [],
      branch: null,
    };
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
