import {
  ACTIVE_STATES,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
  TaskSize,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type ShapeId,
  type ShapePreviewDto,
  type TaskId,
} from '@10db/contracts';
import {
  getProject,
  getShape,
  getTask,
  laneTimesOf,
  listFinishedLaneTimes,
  listFinishedNonLaneMinutes,
  listSessions,
  listShapeLinks,
  listShapeProposals,
  listShapes,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import { simulateFactory, type ScheduleItem } from './preview-schedule';
import { bucketHours, buildSizes, median } from './sizing';

// Shape spec §10.2. What the factory would do with the draft: the project's running and queued work
// holds its lanes first, for what is left of its estimate, then the draft's tasks follow with their
// derived hours. A preview reads and never writes.

const MINUTE_MS = 60_000;

/** The pending tasks of the draft, as the schedule places them. */
function draftItems(
  db: DbReader,
  shapeId: ShapeId,
  fallbackHours: number,
  activeTasks: ReadonlySet<TaskId>,
): ScheduleItem[] {
  const hours = new Map(buildSizes(db, shapeId).map((s) => [s.key, s.hours]));
  const converted = new Map(
    listShapeLinks(db, shapeId).flatMap((l) => (l.taskId === null ? [] : [[l.key, l.taskId]])),
  );
  // A dependency on a task Convert made counts only while that task is running or queued.
  const resolve = (keys: readonly string[]): string[] =>
    keys.flatMap((key) => {
      const id = converted.get(key);
      if (id === undefined) return [key];
      return activeTasks.has(id) ? [id] : [];
    });
  const items: ScheduleItem[] = [];
  for (const row of listShapeProposals(db, shapeId)) {
    if (row.state !== ShapeProposalState.Pending) continue;
    if (row.kind === ShapeProposalKind.Goal) {
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks)
        items.push({
          key: t.key,
          title: t.title,
          hours: hours.get(t.key) ?? fallbackHours,
          areas: t.areas,
          dependsOn: resolve([...t.depends_on, ...t.dependsOnOutside]),
          existing: null,
        });
    } else if (row.kind === ShapeProposalKind.Task) {
      const t = ShapeProposalBody.task.parse(row.body);
      items.push({
        key: row.key,
        title: t.title,
        hours: hours.get(row.key) ?? fallbackHours,
        areas: t.areas,
        dependsOn: resolve(t.dependsOn),
        existing: null,
      });
    }
  }
  return items;
}

/**
 * Running and queued work of the project with what is left of it: its derived hours (when a
 * conversation sized it) or, for a task never sized, the project's median lane time per finished
 * task, less its lane time so far, floored at zero.
 */
function existingItems(
  db: DbReader,
  projectId: ProjectId,
  medianHours: number,
  now: Date,
): ScheduleItem[] {
  const derived = new Map(
    listShapes(db, projectId).flatMap((shape) =>
      buildSizes(db, shape.id).flatMap((s) => (s.taskId === null ? [] : [[s.taskId, s.hours]])),
    ),
  );
  const items: ScheduleItem[] = [];
  const workstreams = listWorkstreams(db, { states: ACTIVE_STATES, projectId }).filter(
    (ws) => ws.state !== WorkstreamState.Held,
  );
  const active = new Set(workstreams.map((ws) => ws.taskId));
  for (const ws of workstreams) {
    const task = getTask(db, ws.taskId);
    // A finished or cancelled task whose last run was left behind holds no lane.
    if (task.status !== TaskStatus.Open) continue;
    const finishedMinutes = laneTimesOf(db, [task.id]).get(task.id)?.minutes ?? 0;
    const runningMinutes = listSessions(db, ws.id).reduce(
      (sum, s) =>
        sum +
        Math.max(
          0,
          (Date.parse(s.endedAt ?? now.toISOString()) - Date.parse(s.startedAt)) / MINUTE_MS,
        ),
      0,
    );
    const soFar = (finishedMinutes + runningMinutes) / 60;
    items.push({
      key: task.id,
      title: task.title,
      hours: Math.max(0, (derived.get(task.id) ?? medianHours) - soFar),
      areas: task.areas,
      dependsOn: task.dependsOn.filter((id) => active.has(id)),
      existing: ws.state === WorkstreamState.Queued ? 'queued' : 'running',
    });
  }
  return items;
}

export function buildPreview(db: DbReader, shapeId: ShapeId, now: Date): ShapePreviewDto {
  const projectId = getShape(db, shapeId).projectId;
  const project = getProject(db, projectId);
  const finished = listFinishedLaneTimes(db, projectId).map((t) => t.minutes / 60);
  // With nothing finished there is no median: the project's M bucket stands in.
  const medianHours =
    finished.length === 0 ? bucketHours(db, projectId)[TaskSize.M] : median(finished);
  const existing = existingItems(db, projectId, medianHours, now);
  const draft = draftItems(db, shapeId, medianHours, new Set(existing.map((i) => i.key as TaskId)));
  const schedule = simulateFactory(project.maxLanes, [...existing, ...draft]);
  const nonLane = listFinishedNonLaneMinutes(db, projectId);
  const nonLaneHoursPerTask = nonLane.length === 0 ? null : median(nonLane) / 60;
  const draftKeys = new Set(draft.map((i) => i.key));
  const pathTasks = schedule.criticalPath.filter((key) => draftKeys.has(key)).length;
  return {
    lanes: schedule.lanes.map((l) => ({ items: [...l.items] })),
    criticalPath: [...schedule.criticalPath],
    clashes: [...schedule.clashes],
    tasks: draft.length,
    totalLaneHours: draft.reduce((sum, i) => sum + i.hours, 0),
    scheduleHours: schedule.scheduleHours,
    nonLaneHoursPerTask,
    endEstimateHours: schedule.scheduleHours + (nonLaneHoursPerTask ?? 0) * pathTasks,
  };
}
