import type { LandingGroupId, TaskDto, TaskId } from '@10db/contracts';

export interface TaskGroup {
  readonly title: string;
  readonly tasks: readonly TaskDto[];
}

/**
 * Tasks linked by a dependency inside the set, directly or through others in it, share a group;
 * so do tasks that share a landing group (Shape spec §10.4), which land in one pull request though
 * nothing makes them wait on each other. Groups come in the order of their first task, and tasks
 * keep the set's order within a group. A group is titled after its first task in set order with no
 * dependency inside the set, unless it holds a task of a landing named in `landingTitles`, which
 * then names it (the first such task's landing). `links` are pairs of tasks that share a group too, as
 * tasks of one goal that ship with it do; a pair naming a task outside the set is ignored. With no landing
 * groups and no links it groups by dependency alone.
 */
export function groupByDependency(
  tasks: readonly TaskDto[],
  landingTitles: ReadonlyMap<LandingGroupId, string> = new Map(),
  links: readonly (readonly [TaskId, TaskId])[] = [],
): TaskGroup[] {
  const parent = new Map<TaskId, TaskId>(tasks.map((t) => [t.id, t.id]));
  const rootOf = (id: TaskId): TaskId => {
    let root = id;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root))
      root = up;
    parent.set(id, root);
    return root;
  };
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!parent.has(dep)) continue;
      const a = rootOf(task.id);
      const b = rootOf(dep);
      if (a !== b) parent.set(a, b);
    }
  }
  // Tasks of one landing group are linked to the first of them in the set.
  const landed = new Map<LandingGroupId, TaskId>();
  for (const task of tasks) {
    if (task.landingGroupId === null || task.landingGroupId === undefined) continue;
    const first = landed.get(task.landingGroupId);
    if (first === undefined) {
      landed.set(task.landingGroupId, task.id);
      continue;
    }
    const a = rootOf(task.id);
    const b = rootOf(first);
    if (a !== b) parent.set(a, b);
  }
  for (const [x, y] of links) {
    if (!parent.has(x) || !parent.has(y)) continue;
    const a = rootOf(x);
    const b = rootOf(y);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<TaskId, TaskDto[]>();
  for (const task of tasks) {
    const root = rootOf(task.id);
    const members = groups.get(root) ?? [];
    members.push(task);
    groups.set(root, members);
  }
  return [...groups.values()].map((members) => {
    const head = members.find((t) => !t.dependsOn.some((dep) => parent.has(dep))) ?? members[0];
    const landing = members
      .map((t) => (t.landingGroupId ? landingTitles.get(t.landingGroupId) : undefined))
      .find((title) => title !== undefined);
    return { title: landing ?? head?.title ?? '', tasks: members };
  });
}
