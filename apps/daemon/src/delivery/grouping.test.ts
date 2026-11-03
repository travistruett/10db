import { mintId, TaskDto, type LandingGroupId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { groupByDependency } from './grouping';

/**
 * One task per name, each depending on the named tasks; X is never in a set. `landings` puts a
 * task in the landing group of that name (one id per name).
 */
function tasksNamed(
  deps: Record<string, readonly string[]>,
  landings: Record<string, string> = {},
): Map<string, TaskDto> {
  const ids = new Map<string, TaskId>(
    ['A', 'B', 'C', 'X'].map((name) => [name, mintId('Task')] as const),
  );
  const groupIds = new Map<string, LandingGroupId>();
  const groupOf = (name: string): LandingGroupId | null => {
    const label = landings[name];
    if (label === undefined) return null;
    const id = groupIds.get(label) ?? mintId('LandingGroup');
    groupIds.set(label, id);
    return id;
  };
  const idOf = (name: string): TaskId => {
    const id = ids.get(name);
    if (!id) throw new Error(`no task ${name}`);
    return id;
  };
  const now = new Date(0).toISOString();
  return new Map(
    [...ids.keys()].map((name) => [
      name,
      TaskDto.parse({
        id: idOf(name),
        projectId: mintId('Project'),
        title: name,
        headline: '',
        why: '',
        description: '',
        acceptanceCriteria: ['it works'],
        areas: ['api'],
        riskTags: [],
        flowId: null,
        landing: { kind: 'base' },
        workspaceMode: 'worktree',
        placementReason: null,
        status: 'open',
        boardOrder: 0,
        boardColumnId: null,
        dependsOn: (deps[name] ?? []).map(idOf),
        boardStatus: 'backlog',
        workstreamId: null,
        ...(groupOf(name) === null ? {} : { landingGroupId: groupOf(name) }),
        createdAt: now,
        updatedAt: now,
      }),
    ]),
  );
}

describe('groupByDependency', () => {
  it.each<{
    name: string;
    set: readonly string[];
    deps: Record<string, readonly string[]>;
    groups: readonly { readonly title: string; readonly members: readonly string[] }[];
  }>([
    {
      name: 'independent tasks',
      set: ['A', 'B', 'C'],
      deps: {},
      groups: [
        { title: 'A', members: ['A'] },
        { title: 'B', members: ['B'] },
        { title: 'C', members: ['C'] },
      ],
    },
    {
      name: 'a chain and an independent task',
      set: ['A', 'B', 'C'],
      deps: { B: ['A'] },
      groups: [
        { title: 'A', members: ['A', 'B'] },
        { title: 'C', members: ['C'] },
      ],
    },
    {
      name: 'a chain given dependent first',
      set: ['B', 'A'],
      deps: { B: ['A'] },
      groups: [{ title: 'A', members: ['B', 'A'] }],
    },
    {
      name: 'linked through a third task',
      set: ['A', 'B', 'C'],
      deps: { C: ['A', 'B'] },
      groups: [{ title: 'A', members: ['A', 'B', 'C'] }],
    },
    {
      name: "a dependency outside the set doesn't link",
      set: ['A', 'B'],
      deps: { A: ['X'], B: ['X'] },
      groups: [
        { title: 'A', members: ['A'] },
        { title: 'B', members: ['B'] },
      ],
    },
  ])('$name', ({ set, deps, groups }) => {
    const tasks = tasksNamed(deps);
    const inSet = set.map((name) => {
      const task = tasks.get(name);
      if (!task) throw new Error(`no task ${name}`);
      return task;
    });
    expect(
      groupByDependency(inSet).map((g) => ({
        title: g.title,
        members: g.tasks.map((t) => t.title),
      })),
    ).toEqual(groups);
  });
});

describe('groupByDependency with landing groups', () => {
  const run = (
    set: readonly string[],
    deps: Record<string, readonly string[]>,
    landings: Record<string, string>,
    titles: Record<string, string> = {},
  ): { title: string; members: string[] }[] => {
    const tasks = tasksNamed(deps, landings);
    const inSet = set.map((name) => {
      const task = tasks.get(name);
      if (!task) throw new Error(`no task ${name}`);
      return task;
    });
    const byGroup = new Map<LandingGroupId, string>();
    for (const name of set) {
      const id = tasks.get(name)?.landingGroupId;
      const label = landings[name];
      const title = label === undefined ? undefined : titles[label];
      if (id && title !== undefined) byGroup.set(id, title);
    }
    return groupByDependency(inSet, byGroup).map((g) => ({
      title: g.title,
      members: g.tasks.map((t) => t.title),
    }));
  };

  it.each<{
    name: string;
    set: readonly string[];
    deps: Record<string, readonly string[]>;
    landings: Record<string, string>;
    groups: readonly { readonly title: string; readonly members: readonly string[] }[];
  }>([
    {
      name: 'two unrelated tasks of one landing share a group',
      set: ['A', 'B', 'C'],
      deps: {},
      landings: { A: 'real', C: 'real' },
      groups: [
        { title: 'A', members: ['A', 'C'] },
        { title: 'B', members: ['B'] },
      ],
    },
    {
      name: 'a landing and a dependency chain join into one group',
      set: ['A', 'B', 'C'],
      deps: { B: ['A'] },
      landings: { B: 'real', C: 'real' },
      groups: [{ title: 'A', members: ['A', 'B', 'C'] }],
    },
    {
      name: 'two landings stay apart',
      set: ['A', 'B', 'C'],
      deps: {},
      landings: { A: 'one', B: 'two', C: 'two' },
      groups: [
        { title: 'A', members: ['A'] },
        { title: 'B', members: ['B', 'C'] },
      ],
    },
    {
      name: 'a task alone in the set from a landing is a group of one',
      set: ['A', 'B'],
      deps: {},
      landings: { A: 'real' },
      groups: [
        { title: 'A', members: ['A'] },
        { title: 'B', members: ['B'] },
      ],
    },
  ])('$name', ({ set, deps, landings, groups }) => {
    expect(run(set, deps, landings)).toEqual(groups);
  });

  it("titles a landing's group after the landing", () => {
    expect(run(['A', 'B', 'C'], {}, { B: 'real', C: 'real' }, { real: 'Real areas' })).toEqual([
      { title: 'A', members: ['A'] },
      { title: 'Real areas', members: ['B', 'C'] },
    ]);
  });
});
