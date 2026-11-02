import type { ProjectId, ProjectViewDto, TaskId } from '@10db/contracts';
import { useEffect, useRef } from 'react';
import { useTasksOfProjects } from '../../daemon/queries';

export interface LinkedTask {
  /** Every project answered and none has the task: it was removed or never existed. */
  readonly missing: boolean;
  /** A project's tasks couldn't be read, so where the task lives is unknown. */
  readonly error: Error | null;
}

/**
 * Finds the project of the task a `?task=` link names and switches the Board to it. A link carries
 * the task's ID alone, and the Board shows one project at a time, so it asks each project. The
 * switch happens once per linked task: choosing another project afterwards isn't undone.
 */
export function useLinkedTask(
  taskId: TaskId | undefined,
  projects: readonly ProjectViewDto[],
  selectedId: ProjectId | null,
  select: (id: ProjectId) => void,
): LinkedTask {
  const lookups = useTasksOfProjects(taskId === undefined ? [] : projects.map((p) => p.id));
  const owner = projects.find((_, i) => lookups[i]?.data?.some((t) => t.id === taskId));
  const switchedFor = useRef<TaskId | undefined>(undefined);

  useEffect(() => {
    if (taskId === undefined || !owner || switchedFor.current === taskId) return;
    switchedFor.current = taskId;
    if (owner.id !== selectedId) select(owner.id);
  }, [taskId, owner, selectedId, select]);

  const failed = owner ? undefined : lookups.find((q) => q.isError);
  return {
    missing: !owner && lookups.length > 0 && lookups.every((q) => q.isSuccess),
    error: failed?.error ?? null,
  };
}
