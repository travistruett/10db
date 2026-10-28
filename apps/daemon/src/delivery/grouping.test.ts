import { mintId, TaskDto, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { groupByDependency } from './grouping';

/** One task per name, each depending on the named tasks; X is never in a set. */
function tasksNamed(deps: Record<string, readonly string[]>): Map<string, TaskDto> {
  const ids = new Map<string, TaskId>(
    ['A', 'B', 'C', 'X'].map((name) => [name, mintId('Task')] as const),
  );
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
        description: '',
        acceptanceCriteria: ['it works'],
        areas: ['api'],
        riskTags: [],
        flowId: null,
        status: 'open',
        boardOrder: 0,
        boardColumnId: null,
        dependsOn: (deps[name] ?? []).map(idOf),
        boardStatus: 'backlog',
        workstreamId: null,
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
