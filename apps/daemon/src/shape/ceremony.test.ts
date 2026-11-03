import { CeremonyReason, DEFAULT_ONE_WAY_PATHS, TaskSize, type AreaDef } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { ceremonyFor, effectiveOneWayPaths, oneWayNamesOf, type EffortFacts } from './ceremony';

// Shape spec §7: an L loose task, an XL goal, more than 5 tasks or a one-way path forces spec; the
// builder can pin a forced effort to direct, and it then reads "spec skipped by you".

const none = new Set<string>();
const loose = (over: Partial<EffortFacts> = {}): EffortFacts => ({
  kind: 'task',
  claude: 'direct',
  pinnedCeremony: false,
  size: TaskSize.S,
  hours: 0.5,
  taskCount: 1,
  taskAreas: [['api']],
  ...over,
});
const goal = (over: Partial<EffortFacts> = {}): EffortFacts =>
  loose({ kind: 'goal', size: undefined, hours: 4, taskCount: 3, ...over });

describe('what forces spec', () => {
  it.each([
    ['a small loose task', loose(), []],
    ['an M loose task', loose({ size: TaskSize.M, hours: 2 }), []],
    ['an L loose task', loose({ size: TaskSize.L, hours: 5.5 }), [CeremonyReason.LooseL]],
    [
      'an XL loose task (it will be refused, but the rule still reads it)',
      loose({ size: TaskSize.XL, hours: 10 }),
      [CeremonyReason.LooseL],
    ],
    ['a goal of 8 hours', goal({ hours: 8 }), []],
    ['a goal of over 8 hours', goal({ hours: 8.5 }), [CeremonyReason.GoalXl]],
    ['a goal of 5 tasks', goal({ taskCount: 5 }), []],
    ['a goal of 6 tasks', goal({ taskCount: 6 }), [CeremonyReason.ManyTasks]],
    [
      'a goal that is both big and many',
      goal({ hours: 9, taskCount: 7 }),
      [CeremonyReason.GoalXl, CeremonyReason.ManyTasks],
    ],
  ])('%s', (_name, facts, reasons) => {
    expect(ceremonyFor(facts, none).reasons).toEqual(reasons);
  });

  it('a task in an area that shares a file with the one-way paths', () => {
    const facts = loose({ taskAreas: [['ui', 'db']] });
    expect(ceremonyFor(facts, new Set(['db'])).reasons).toEqual([CeremonyReason.OneWayPath]);
    expect(ceremonyFor(facts, new Set(['other'])).reasons).toEqual([]);
  });

  it('any task of a goal counts, not just the first', () => {
    const facts = goal({ taskAreas: [['ui'], ['ui'], ['db']] });
    expect(ceremonyFor(facts, new Set(['db'])).reasons).toEqual([CeremonyReason.OneWayPath]);
  });
});

describe('what applies', () => {
  it('direct when nothing forces it and Claude chose direct', () => {
    expect(ceremonyFor(loose(), none)).toMatchObject({ ceremony: 'direct', skippedByYou: false });
  });

  it('spec when Claude chose it, even if nothing forces it', () => {
    expect(ceremonyFor(loose({ claude: 'spec' }), none)).toMatchObject({
      ceremony: 'spec',
      reasons: [],
    });
  });

  it('spec when forced, whatever Claude wrote', () => {
    expect(ceremonyFor(loose({ size: TaskSize.L, hours: 5 }), none)).toMatchObject({
      ceremony: 'spec',
      skippedByYou: false,
    });
  });

  it('direct when forced but the builder pinned direct: "spec skipped by you"', () => {
    const facts = loose({ size: TaskSize.L, hours: 5, pinnedCeremony: true });
    expect(ceremonyFor(facts, none)).toMatchObject({
      ceremony: 'direct',
      skippedByYou: true,
      reasons: [CeremonyReason.LooseL],
    });
  });

  it('a pin on spec is spec, and a pin on direct with nothing forced is plain direct', () => {
    expect(ceremonyFor(loose({ claude: 'spec', pinnedCeremony: true }), none).ceremony).toBe(
      'spec',
    );
    expect(ceremonyFor(loose({ pinnedCeremony: true }), none)).toMatchObject({
      ceremony: 'direct',
      skippedByYou: false,
    });
  });
});

describe('the one-way paths', () => {
  const areas: AreaDef[] = [
    { name: 'db', globs: ['packages/db/**'] },
    { name: 'ui', globs: ['apps/desktop/**'] },
    { name: 'repo', globs: ['**'], catchAll: true },
  ];
  const tracked = [
    'packages/db/src/schema.ts',
    'packages/db/drizzle/0001.sql',
    'apps/desktop/src/app.tsx',
    'README.md',
  ];

  it('name the areas that hold a tracked file matching a one-way glob', () => {
    expect([
      ...oneWayNamesOf({ tracked, globs: ['packages/db/drizzle/**'], areas, hazards: [] }),
    ]).toEqual(['db']);
  });

  it('two globs never need intersecting: a catch-all area holds any file, so it is one-way too', () => {
    const names = oneWayNamesOf({
      tracked,
      globs: ['README.md', 'packages/db/src/schema.ts'],
      areas,
      hazards: [],
    });
    expect([...names].sort()).toEqual(['db', 'repo']);
  });

  it('match nothing when no tracked file matches', () => {
    expect(oneWayNamesOf({ tracked, globs: ['nope/**'], areas, hazards: [] }).size).toBe(0);
  });

  it('include a hazard whose glob holds one', () => {
    const names = oneWayNamesOf({
      tracked,
      globs: ['packages/db/drizzle/**'],
      areas,
      hazards: [
        { name: 'migrations', globs: ['packages/db/drizzle/**'], commands: [], scope: 'project' },
      ],
    });
    expect([...names].sort()).toEqual(['db', 'migrations']);
  });
});

describe('the setting', () => {
  const tracked = ['packages/db/src/schema.ts', 'packages/contracts/src/index.ts'];

  it('is what the builder set, empty included', () => {
    expect(effectiveOneWayPaths(['x/**'], tracked)).toEqual(['x/**']);
    expect(effectiveOneWayPaths([], tracked)).toEqual([]);
  });

  it('defaults to the 10db paths that exist in this project, and to none elsewhere', () => {
    expect(effectiveOneWayPaths(null, tracked)).toEqual([
      'packages/db/src/schema.ts',
      'packages/contracts/src/**',
    ]);
    expect(effectiveOneWayPaths(null, ['src/index.ts'])).toEqual([]);
    expect(DEFAULT_ONE_WAY_PATHS).toHaveLength(3);
  });
});
