import {
  ACTIVE_STATES,
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
  TaskSize,
  Delivery,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type ShapeId,
  type ShapePreviewDto,
  type ShapeProposalId,
  type ShapeStartCountsDto,
  type ShapePreviewLandings,
  type TaskId,
} from '@10db/contracts';
import {
  getProject,
  getShape,
  findShapeLinkOfTask,
  getTask,
  laneTimesOf,
  listFinishedLaneTimes,
  listFinishedNonLaneMinutes,
  listSessions,
  listShapeLinks,
  listShapeProposals,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import { taskFinished } from '../delivery';
import { proposePlacement } from '../placement';
import { simulateFactory, type ScheduleItem } from './preview-schedule';
import { bucketHours, buildSizes, median } from './sizing';
import { START_CAP, startCounts, type StartCountTask } from './start-counts';

// Shape spec §10.2. What the factory would do with the draft: the project's running and queued work
// holds its lanes first, for what is left of its estimate, then the draft's tasks follow with their
// derived hours. A preview reads and never writes.

const MINUTE_MS = 60_000;

/** A pending task of the draft, with the keys it waits on as the proposal names them. */
interface DraftTask {
  readonly key: string;
  readonly title: string;
  readonly areas: readonly string[];
  readonly waitsOn: readonly string[];
}

/** The pending tasks of the draft, goal tasks first as their goal comes, limited to `only` when given. */
function draftTasks(
  db: DbReader,
  shapeId: ShapeId,
  only: ReadonlySet<ShapeProposalId> | null,
): DraftTask[] {
  const tasks: DraftTask[] = [];
  for (const row of listShapeProposals(db, shapeId)) {
    if (row.state !== ShapeProposalState.Pending) continue;
    if (only !== null && !only.has(row.id)) continue;
    if (row.kind === ShapeProposalKind.Goal) {
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks)
        tasks.push({
          key: t.key,
          title: t.title,
          areas: t.areas,
          waitsOn: [...t.depends_on, ...t.dependsOnOutside],
        });
    } else if (row.kind === ShapeProposalKind.Task) {
      const t = ShapeProposalBody.task.parse(row.body);
      tasks.push({ key: row.key, title: t.title, areas: t.areas, waitsOn: t.dependsOn });
    }
  }
  return tasks;
}

/** The pending tasks of the draft, as the schedule places them. */
function draftItems(
  db: DbReader,
  shapeId: ShapeId,
  fallbackHours: number,
  activeTasks: ReadonlySet<TaskId>,
  only: ReadonlySet<ShapeProposalId> | null = null,
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
  return draftTasks(db, shapeId, only).map((t) => ({
    key: t.key,
    title: t.title,
    hours: hours.get(t.key) ?? fallbackHours,
    areas: t.areas,
    dependsOn: resolve(t.waitsOn),
    existing: null,
  }));
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
  const items: ScheduleItem[] = [];
  const workstreams = listWorkstreams(db, { states: ACTIVE_STATES, projectId }).filter(
    (ws) => ws.state !== WorkstreamState.Held,
  );
  const active = new Set(workstreams.map((ws) => ws.taskId));
  // Sizes are read only for the conversations that made a running or queued task (through
  // shape_links), not for every conversation of the project.
  const shapes = new Set(
    [...active].flatMap((taskId) => {
      const link = findShapeLinkOfTask(db, taskId);
      return link === undefined ? [] : [link.shapeId];
    }),
  );
  const derived = new Map(
    [...shapes].flatMap((shapeId) =>
      buildSizes(db, shapeId).flatMap((s) =>
        s.taskId === null || !active.has(s.taskId) ? [] : [[s.taskId, s.hours]],
      ),
    ),
  );
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

/**
 * The pull requests the draft's tasks would make: a pull request is a batch, which tasks that wait
 * on each other share, and so do the tasks of a landing. The same without the landings is what each
 * task would make landing alone. Each pull request has one CI run (the project has no merge queue).
 */
function countLandings(
  db: DbReader,
  shapeId: ShapeId,
  draft: readonly ScheduleItem[],
): ShapePreviewLandings {
  const parent = new Map<string, string>(draft.map((i) => [i.key, i.key]));
  const rootOf = (key: string): string => {
    let root = key;
    for (let up = parent.get(root); up !== undefined && up !== root; up = parent.get(root))
      root = up;
    return root;
  };
  const link = (a: string, b: string): void => {
    if (!parent.has(a) || !parent.has(b)) return;
    const x = rootOf(a);
    const y = rootOf(b);
    if (x !== y) parent.set(x, y);
  };
  const components = (): number => new Set(draft.map((i) => rootOf(i.key))).size;
  for (const item of draft) for (const dep of item.dependsOn) link(item.key, dep);
  const alone = components();
  for (const row of listShapeProposals(db, shapeId)) {
    if (row.state !== ShapeProposalState.Pending || row.kind !== ShapeProposalKind.Landing)
      continue;
    // A key of a task already converted is not in the draft; the rest of the landing still is.
    const [first, ...rest] = ShapeProposalBody.landing
      .parse(row.body)
      .keys.filter((k) => parent.has(k));
    if (first !== undefined) for (const key of rest) link(first, key);
  }
  const together = components();
  return { pullRequests: together, pullRequestsAlone: alone, ciRuns: together, ciRunsAlone: alone };
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
    landings: countLandings(db, shapeId, draft),
  };
}

/**
 * What Accept and Start would do with the given pending proposals: the tasks that start, how many at
 * once, for a lane or for other tasks, and those it leaves on the Board with why. It runs the same
 * lane simulation as the preview, over the chosen rows only, and writes nothing.
 */
export function buildStartCounts(
  db: DbReader,
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
  now: Date,
): ShapeStartCountsDto {
  const projectId = getShape(db, shapeId).projectId;
  const project = getProject(db, projectId);
  const finished = listFinishedLaneTimes(db, projectId).map((t) => t.minutes / 60);
  const medianHours =
    finished.length === 0 ? bucketHours(db, projectId)[TaskSize.M] : median(finished);
  const existing = existingItems(db, projectId, medianHours, now);
  const only = new Set(proposalIds);
  const draft = draftItems(
    db,
    shapeId,
    medianHours,
    new Set(existing.map((i) => i.key as TaskId)),
    only,
  );
  const schedule = simulateFactory(project.maxLanes, [...existing, ...draft]);
  const draftKeys = new Set(draft.map((i) => i.key));
  const startsAtOnce = new Set(
    schedule.lanes.flatMap((l) =>
      l.items.filter((i) => draftKeys.has(i.key) && i.startHours === 0).map((i) => i.key),
    ),
  );
  const converted = new Map(
    listShapeLinks(db, shapeId).flatMap((l) => (l.taskId === null ? [] : [[l.key, l.taskId]])),
  );
  const tasks: StartCountTask[] = draftTasks(db, shapeId, only).map((t) => ({
    key: t.key,
    title: t.title,
    place: proposePlacement(project, { areas: t.areas, kinds: [] }).workspaceMode,
    waitsOnStart: t.waitsOn.filter((key) => draftKeys.has(key)),
    waitsOutside: t.waitsOn.flatMap((key) => {
      if (draftKeys.has(key)) return [];
      const id = converted.get(key);
      if (id === undefined) return [key];
      const dep = getTask(db, id);
      return taskFinished(dep) ? [] : [dep.title];
    }),
  }));
  const {
    now: atOnce,
    forLane,
    forOthers,
    stay,
  } = startCounts({
    tasks,
    startsAtOnce,
    local: project.delivery !== Delivery.PullRequest,
    cap: START_CAP,
  });
  return { now: atOnce, forLane, forOthers, stay };
}
