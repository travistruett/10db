import {
  BoardStatus,
  TaskStatus,
  WorkstreamState,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';

const S = WorkstreamState;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Factory's live sections, in the order they show: what needs the builder first, what finished last. */
export const LiveGroup = {
  NeedsYou: 'needs_you',
  Failed: 'failed',
  Running: 'running',
  InReview: 'in_review',
  Waiting: 'waiting',
  Done: 'done',
} as const;
export type LiveGroup = (typeof LiveGroup)[keyof typeof LiveGroup];

const ORDER: readonly LiveGroup[] = [
  LiveGroup.NeedsYou,
  LiveGroup.Failed,
  LiveGroup.Running,
  LiveGroup.InReview,
  LiveGroup.Waiting,
  LiveGroup.Done,
];

/** What the list needs of a run's task: whether it was closed, where the Board has it, and its latest run. */
export interface LiveTask {
  readonly status: TaskStatus;
  readonly boardStatus: BoardStatus;
  readonly workstreamId: WorkstreamId | null;
}

/**
 * When a run last did anything: a finished or failed run's last change (its finish), else its last activity,
 * else its last change.
 */
export function lastMoment(ws: WorkstreamDto): string {
  if (ws.state === S.Done || ws.state === S.Failed) return ws.updatedAt;
  return ws.lastActivityAt ?? ws.updatedAt;
}

/** Which section a run sits in; null when it shows nowhere (cancelled, closed, or finished too long ago). */
function groupOf(
  ws: WorkstreamDto,
  task: LiveTask | undefined,
  tasksKnown: boolean,
  now: number,
): LiveGroup | null {
  // The task lists leave closed tasks out, so once they are read a run whose task is missing was closed.
  if (tasksKnown && task === undefined) return null;
  const age = now - new Date(lastMoment(ws)).getTime();
  switch (ws.state) {
    case S.WaitingHuman:
      // A question out with someone else waits on them, not on the builder.
      return ws.waitingOn === null ? LiveGroup.NeedsYou : LiveGroup.Waiting;
    case S.Failed:
      // A failure stays for a week, unless its task was closed.
      return task?.status === TaskStatus.Cancelled || age > 7 * DAY_MS ? null : LiveGroup.Failed;
    case S.Starting:
    case S.Running:
    case S.HandingOff:
    case S.Verifying:
    case S.Recovering:
    case S.PausedLimit:
    case S.TakenOver:
      return LiveGroup.Running;
    case S.Queued:
    case S.Held:
      return LiveGroup.Waiting;
    case S.Done:
      // A run that finished with its pull request still open is in review, never done (DESIGN.md, Goals).
      if (task !== undefined && task.boardStatus !== BoardStatus.Done) {
        return task.boardStatus === BoardStatus.InReview ? LiveGroup.InReview : null;
      }
      return age <= DAY_MS ? LiveGroup.Done : null;
    case S.Cancelled:
      return null;
  }
}

/**
 * Every project's runs as the Factory's sections: each task's latest run only (the task's own `workstreamId`
 * when the task is known, else the run made last), newest activity first within a section, and a section with
 * nothing in it left out. Runs of tasks a live UI Workbench pass holds are the pass's row, not their own.
 */
export function liveGroups(
  workstreams: readonly WorkstreamDto[],
  tasks: ReadonlyMap<TaskId, LiveTask>,
  /** Every shown project's tasks were read, so a task missing from `tasks` was closed. */
  tasksKnown: boolean,
  heldByPass: ReadonlySet<TaskId>,
  now: number,
): { readonly group: LiveGroup; readonly rows: readonly WorkstreamDto[] }[] {
  const latest = new Map<TaskId, WorkstreamDto>();
  for (const ws of workstreams) {
    if (heldByPass.has(ws.taskId)) continue;
    const named = tasks.get(ws.taskId)?.workstreamId;
    if (named !== undefined && named !== null) {
      if (ws.id === named) latest.set(ws.taskId, ws);
      continue;
    }
    const seen = latest.get(ws.taskId);
    if (
      seen === undefined ||
      ws.createdAt > seen.createdAt ||
      (ws.createdAt === seen.createdAt && ws.id > seen.id)
    )
      latest.set(ws.taskId, ws);
  }
  const by = new Map<LiveGroup, WorkstreamDto[]>();
  for (const ws of latest.values()) {
    const group = groupOf(ws, tasks.get(ws.taskId), tasksKnown, now);
    if (group !== null) by.set(group, [...(by.get(group) ?? []), ws]);
  }
  const at = (ws: WorkstreamDto): number => new Date(lastMoment(ws)).getTime();
  return ORDER.flatMap((group) => {
    const rows = by.get(group);
    return rows === undefined ? [] : [{ group, rows: [...rows].sort((a, b) => at(b) - at(a)) }];
  });
}
