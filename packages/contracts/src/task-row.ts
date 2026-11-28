import { z } from 'zod';
import { TaskDto } from './entities';
import type { ProjectId } from './ids';
import { EffectiveRigorSource, Rigor } from './rigor';
import { BoardStatus, TaskStatus, WorkspaceMode } from './states';

/**
 * What the project's task list sends for a task. The list is read often and holds every task the project
 * ever had, so a row carries what the Board, Factory and the other lists show of a task, leaves out the
 * rest (the description, the criteria with a count in their place, the rigor's reasons, who sized it), and
 * cuts a task that is done and merged to what finding it, ordering it and linking its run need. The task's
 * own read (`GET /tasks/:taskId`) has all of it, and is what a drawer shows.
 */
const Core = TaskDto.pick({
  id: true,
  title: true,
  why: true,
  boardOrder: true,
  updatedAt: true,
  goalId: true,
  landingGroupId: true,
  passId: true,
  external: true,
}).extend({
  /** Left out when empty. */
  dependsOn: TaskDto.shape.dependsOn.optional(),
  /** Left out when the task has no run. */
  workstreamId: TaskDto.shape.workstreamId.unwrap().optional(),
});

/** A task done and merged: its status and column follow from that, so it names neither. */
const SettledRow = Core.extend({
  settled: z.literal(true),
  why: TaskDto.shape.why.optional(),
});

const LiveRow = Core.extend({
  settled: z.literal(false).optional(),
  criteriaCount: z.number(),
  ...TaskDto.pick({
    status: true,
    boardStatus: true,
    areas: true,
    rigor: true,
    effectiveRigor: true,
    kinds: true,
    landing: true,
    workspaceMode: true,
    placementReason: true,
    boardColumnId: true,
    keptWork: true,
  }).shape,
});

export const TaskRowDto = z.union([SettledRow, LiveRow]);
export type TaskRowDto = z.infer<typeof TaskRowDto>;

/** The row the project's task list sends for a task. */
export function toTaskRow(task: TaskDto): TaskRowDto {
  const core = {
    id: task.id,
    title: task.title,
    boardOrder: task.boardOrder,
    updatedAt: task.updatedAt,
    ...(task.why === '' ? {} : { why: task.why }),
    ...(task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
    ...(task.workstreamId === null ? {} : { workstreamId: task.workstreamId }),
    ...(task.goalId == null ? {} : { goalId: task.goalId }),
    ...(task.landingGroupId == null ? {} : { landingGroupId: task.landingGroupId }),
    ...(task.passId == null ? {} : { passId: task.passId }),
    ...(task.external == null ? {} : { external: task.external }),
  };
  if (task.status === TaskStatus.Done && task.boardStatus === BoardStatus.Done)
    return { ...core, settled: true };
  return {
    ...core,
    why: task.why,
    criteriaCount: task.acceptanceCriteria.length,
    status: task.status,
    boardStatus: task.boardStatus,
    areas: task.areas,
    rigor: task.rigor,
    effectiveRigor: task.effectiveRigor,
    kinds: task.kinds,
    landing: task.landing,
    workspaceMode: task.workspaceMode,
    placementReason: task.placementReason,
    boardColumnId: task.boardColumnId,
    ...(task.keptWork === undefined ? {} : { keptWork: task.keptWork }),
  };
}

/**
 * The task a row stands for, as the rest of the app reads a task. What a row leaves out reads as empty
 * (`description`, `acceptanceCriteria`, the rigor's reasons) or as its default (who sized it, and a settled
 * task's kinds, rigor and placement); the task's own read has the true values.
 */
export function fromTaskRow(projectId: ProjectId, row: TaskRowDto): TaskDto {
  const shared = {
    id: row.id,
    projectId,
    title: row.title,
    why: row.why ?? '',
    description: '',
    acceptanceCriteria: [],
    boardOrder: row.boardOrder,
    updatedAt: row.updatedAt,
    createdAt: row.updatedAt,
    dependsOn: row.dependsOn ?? [],
    workstreamId: row.workstreamId ?? null,
    goalId: row.goalId ?? null,
    landingGroupId: row.landingGroupId ?? null,
    passId: row.passId ?? null,
    external: row.external ?? null,
    rigorSource: null,
    rigorReason: null,
    effectiveRigorSource: EffectiveRigorSource.Default,
    effectiveRigorReason: null,
    kindsOff: [],
    sizedByRules: true,
    effortPin: null,
    modelSetting: null,
  };
  if (row.settled === true)
    return {
      ...shared,
      status: TaskStatus.Done,
      boardStatus: BoardStatus.Done,
      areas: [],
      rigor: null,
      effectiveRigor: Rigor.Standard,
      kinds: [],
      landing: { kind: 'base' },
      workspaceMode: WorkspaceMode.Shared,
      placementReason: null,
      boardColumnId: null,
    };
  return {
    ...shared,
    criteriaCount: row.criteriaCount,
    status: row.status,
    boardStatus: row.boardStatus,
    areas: row.areas,
    rigor: row.rigor,
    effectiveRigor: row.effectiveRigor,
    kinds: row.kinds,
    landing: row.landing,
    workspaceMode: row.workspaceMode,
    placementReason: row.placementReason,
    boardColumnId: row.boardColumnId,
    ...(row.keptWork === undefined ? {} : { keptWork: row.keptWork }),
  };
}
