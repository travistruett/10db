import {
  ShapeProposalBody,
  ShapeProposalKind,
  ShapeProposalState,
  SizeSource,
  TaskSize,
  TaskStatus,
  type ProjectId,
  type ShapeId,
  type ShapeTaskSizeDto,
  type SizingMeasureDto,
  type TaskId,
} from '@10db/contracts';
import {
  getShape,
  getTask,
  laneTimesOf,
  listFinishedLaneTimes,
  listShapeLinks,
  listShapeProposals,
  listShapes,
  listProjects,
  type DbReader,
  type ShapeProposalRow,
} from '@10db/db';

// Shape spec §8. One source per field: Claude writes a task's basis (finished tasks it resembles) or,
// with none, a bucket; the daemon derives hours and the bucket from lane time. The builder's pinned
// bucket wins. Once a converted task finishes, its actual is shown beside its size, and Settings
// measures how often the derived size was within one bucket.

const BUCKETS = [TaskSize.S, TaskSize.M, TaskSize.L, TaskSize.XL] as const;
/** S under 1 h, M 1–3 h, L 3–8 h, XL over 8 h of lane time. */
const UPPER_HOURS: Readonly<Record<TaskSize, number>> = { S: 1, M: 3, L: 8, XL: Infinity };
/** A bucket's hours until it holds enough finished tasks for a median. */
const MIDPOINT_HOURS: Readonly<Record<TaskSize, number>> = { S: 0.5, M: 2, L: 5.5, XL: 10 };
/** A bucket's median replaces its midpoint once it holds this many finished tasks. */
export const BUCKET_MEDIAN_MIN = 10;

export function bucketOf(hours: number): TaskSize {
  return BUCKETS.find((b) => hours < UPPER_HOURS[b]) ?? TaskSize.XL;
}

/** Within one bucket either way: S and M agree, S and L do not. */
export function withinOneBucket(a: TaskSize, b: TaskSize): boolean {
  return Math.abs(BUCKETS.indexOf(a) - BUCKETS.indexOf(b)) <= 1;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Each bucket's hours for the project: its median over finished tasks, or its midpoint below 10. */
export function bucketHours(db: DbReader, projectId: ProjectId): Record<TaskSize, number> {
  const hours = listFinishedLaneTimes(db, projectId).map((t) => t.minutes / 60);
  const out = { ...MIDPOINT_HOURS };
  for (const bucket of BUCKETS) {
    const inside = hours.filter((h) => bucketOf(h) === bucket);
    if (inside.length >= BUCKET_MEDIAN_MIN) out[bucket] = median(inside);
  }
  return out;
}

/** A task as a proposal states it: its own key, how it is sized, and which pin would hold its size. */
interface ProposedTask {
  readonly row: ShapeProposalRow;
  readonly key: string;
  readonly basis: readonly TaskId[] | undefined;
  readonly size: TaskSize | undefined;
  /** The builder pinned this task's size. */
  readonly pinned: boolean;
}

function proposedTasks(row: ShapeProposalRow): ProposedTask[] {
  if (row.kind === ShapeProposalKind.Task) {
    const body = ShapeProposalBody.task.parse(row.body);
    return [
      {
        row,
        key: row.key,
        basis: body.basis,
        size: body.size,
        pinned: row.pinned.includes('size') || row.pinned.includes('*'),
      },
    ];
  }
  if (row.kind === ShapeProposalKind.Goal) {
    const body = ShapeProposalBody.goal.parse(row.body);
    return body.tasks.map((t) => ({
      row,
      key: t.key,
      basis: t.basis,
      size: t.size,
      pinned: row.pinned.includes(`tasks.${t.key}.size`) || row.pinned.includes('*'),
    }));
  }
  return [];
}

interface Derived {
  readonly size: TaskSize;
  readonly hours: number;
  readonly from: SizeSource;
}

function derive(
  db: DbReader,
  task: ProposedTask,
  buckets: Readonly<Record<TaskSize, number>>,
): Derived | null {
  if (task.pinned && task.size !== undefined)
    return { size: task.size, hours: buckets[task.size], from: SizeSource.Pinned };
  if (task.basis !== undefined) {
    // A basis task with no lane time recorded is left out; with none left, the size can't be derived.
    const minutes = [...laneTimesOf(db, task.basis).values()].map((t) => t.minutes);
    if (minutes.length === 0) return null;
    const hours = median(minutes) / 60;
    return { size: bucketOf(hours), hours, from: SizeSource.Basis };
  }
  if (task.size !== undefined)
    return { size: task.size, hours: buckets[task.size], from: SizeSource.Size };
  return null;
}

interface Sized extends Derived {
  readonly task: ProposedTask;
  readonly taskId: TaskId | null;
  readonly actualHours: number | null;
}

function sizedTasks(db: DbReader, shapeId: ShapeId): Sized[] {
  const shape = getShape(db, shapeId);
  const buckets = bucketHours(db, shape.projectId);
  const links = listShapeLinks(db, shapeId);
  const out: Sized[] = [];
  for (const row of listShapeProposals(db, shapeId)) {
    if (row.state === ShapeProposalState.Rejected) continue;
    for (const task of proposedTasks(row)) {
      const derived = derive(db, task, buckets);
      if (derived === null) continue;
      const taskId =
        links.find((l) => l.proposalId === row.id && l.key === task.key && l.taskId !== null)
          ?.taskId ?? null;
      let actualHours: number | null = null;
      if (taskId !== null && getTask(db, taskId).status === TaskStatus.Done) {
        const lane = laneTimesOf(db, [taskId]).get(taskId);
        actualHours = lane === undefined ? null : lane.minutes / 60;
      }
      out.push({ ...derived, task, taskId, actualHours });
    }
  }
  return out;
}

/** Every proposed task's size and hours in a conversation, with the actual once it has finished. */
export function buildSizes(db: DbReader, shapeId: ShapeId): ShapeTaskSizeDto[] {
  return sizedTasks(db, shapeId).map((s) => ({
    proposalId: s.task.row.id,
    key: s.task.key,
    size: s.size,
    hours: s.hours,
    from: s.from,
    taskId: s.taskId,
    actualHours: s.actualHours,
    missized: s.actualHours !== null && !withinOneBucket(s.size, bucketOf(s.actualHours)),
  }));
}

/**
 * Settings › Decisions › Sizing: of the finished converted tasks with lane time, the share whose
 * derived size is within one bucket of what they took, overall and per bucket. Pinned sizes are
 * counted beside it as overrides, never in it.
 */
export function sizingMeasure(db: DbReader): SizingMeasureDto {
  const empty = () => ({ n: 0, within: 0 });
  const out: SizingMeasureDto = {
    n: 0,
    within: 0,
    buckets: { S: empty(), M: empty(), L: empty(), XL: empty() },
    overrides: 0,
  };
  for (const project of listProjects(db))
    for (const shape of listShapes(db, project.id))
      for (const s of sizedTasks(db, shape.id)) {
        if (s.actualHours === null) continue;
        if (s.from === SizeSource.Pinned) {
          out.overrides += 1;
          continue;
        }
        const hit = withinOneBucket(s.size, bucketOf(s.actualHours)) ? 1 : 0;
        out.n += 1;
        out.within += hit;
        out.buckets[s.size].n += 1;
        out.buckets[s.size].within += hit;
      }
  return out;
}
