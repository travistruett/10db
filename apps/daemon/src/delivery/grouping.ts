import type { TaskDto, TaskId } from '@10db/contracts';

export interface TaskGroup {
  readonly title: string;
  readonly tasks: readonly TaskDto[];
}

/**
 * W3: tasks linked by a dependency inside the set, directly or through others in it, share a group.
 * Groups come in the order of their first task, and tasks keep the set's order within a group. A
 * group is titled after its first task in set order with no dependency inside the set.
 */
export function groupByDependency(tasks: readonly TaskDto[]): TaskGroup[] {
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
  const groups = new Map<TaskId, TaskDto[]>();
  for (const task of tasks) {
    const root = rootOf(task.id);
    const members = groups.get(root) ?? [];
    members.push(task);
    groups.set(root, members);
  }
  return [...groups.values()].map((members) => {
    const head = members.find((t) => !t.dependsOn.some((dep) => parent.has(dep))) ?? members[0];
    return { title: head?.title ?? '', tasks: members };
  });
}
