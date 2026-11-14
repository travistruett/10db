import {
  effectiveRigor,
  Rigor,
  TaskKindSource,
  TaskStatus,
  type KindDto,
  type ProjectId,
  type TaskId,
  type TaskKind,
} from '@10db/contracts';
import type { LegacyRouting } from '@10db/db';
import type { ScopedMoveEntry } from './move-entries';
import { rigorOfFlow } from './move-rigor';

export interface MovedTask {
  readonly taskId: TaskId;
  readonly rigor: Rigor | null;
  readonly kinds: readonly TaskKind[];
}

export interface MovedRigor {
  readonly projects: readonly { readonly projectId: ProjectId; readonly rigor: Rigor }[];
  readonly tasks: readonly MovedTask[];
  readonly entries: readonly ScopedMoveEntry[];
}

/**
 * The rigor and kinds today's flows and risk tags make. A project's flow sets its default rigor and a task's
 * its own; a risk tag becomes the kind of that key, given by the builder. A task with kinds is stored at the
 * rigor its kinds raise it to, so it keeps the steps it had. A tag whose kind the builder deleted is
 * reported per project.
 */
export function moveRigor(legacy: LegacyRouting, kinds: readonly KindDto[]): MovedRigor {
  const rigorOfFlowId = new Map(legacy.flows.map((f) => [f.id, rigorOfFlow(f)]));
  const known = new Set(kinds.map((k) => k.key));
  const projectDefault = new Map(
    legacy.projects.map((p) => [
      p.id,
      p.flowId === null ? Rigor.Standard : (rigorOfFlowId.get(p.flowId) ?? Rigor.Standard),
    ]),
  );
  const projects = legacy.projects.flatMap((p) =>
    p.flowId === null || !rigorOfFlowId.has(p.flowId)
      ? []
      : [{ projectId: p.id, rigor: projectDefault.get(p.id) ?? Rigor.Standard }],
  );
  const lost = new Map<ProjectId, Map<string, number>>();
  const tasks = legacy.tasks.flatMap((task): MovedTask[] => {
    if (task.status === TaskStatus.Cancelled) return [];
    const taskKinds: TaskKind[] = [];
    for (const tag of task.riskTags) {
      if (known.has(tag)) taskKinds.push({ key: tag, source: TaskKindSource.Builder });
      else {
        const tags = lost.get(task.projectId) ?? new Map<string, number>();
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
        lost.set(task.projectId, tags);
      }
    }
    const own = task.flowId === null ? null : (rigorOfFlowId.get(task.flowId) ?? null);
    if (own === null && taskKinds.length === 0) return [];
    const fallback = projectDefault.get(task.projectId) ?? Rigor.Standard;
    const effective = effectiveRigor({ rigor: own, projectDefault: fallback, taskKinds, kinds });
    // A task that only follows its project stays following it unless its kinds raised it.
    const rigor = own === null && effective === fallback ? null : effective;
    return [{ taskId: task.id, rigor, kinds: taskKinds }];
  });
  const entries = [...lost].flatMap(([projectId, tags]) =>
    [...tags].map(([tag, count]): ScopedMoveEntry => ({
      projectId,
      setting: `Risk tag "${tag}"`,
      value: `${String(count)} ${count === 1 ? 'task' : 'tasks'}`,
      why: 'No kind has the key of that risk tag, so the tasks keep none',
    })),
  );
  return { projects, tasks, entries };
}
