import {
  BoardStatus,
  StepRole,
  TaskStatus,
  WorkstreamState,
  type BatchDto,
  type DigestTeamMember,
  type GoalProgress,
  type TaskDto,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';
import { canRetryRun, taskState } from '../board/task-state';

const S = WorkstreamState;

/** What a running row says of its step: "Implement 2/4 · sonnet". */
const STEP_LABEL: Readonly<Record<StepRole, string>> = {
  [StepRole.Plan]: 'Plan',
  [StepRole.PlanReview]: 'Plan review',
  [StepRole.Implement]: 'Implement',
  [StepRole.Review]: 'Review',
  [StepRole.Qa]: 'QA',
};

const RUNNING_STATES: ReadonlySet<WorkstreamState> = new Set([
  S.Starting,
  S.Running,
  S.HandingOff,
  S.Verifying,
  S.TakenOver,
]);

export interface TaskRow {
  readonly taskId: TaskId;
  /** The headline, or the title when the task has none. */
  readonly label: string;
  readonly color: MantineColor;
  /** The row's one state, such as "In review · Pull request open · checks passing". */
  readonly state: string;
  /** The raw reason behind a failure, for a tooltip. */
  readonly detail: string | null;
  /** The step and context of a run that is under way; null for every other row. */
  readonly running: { readonly step: string; readonly contextPct: number | null } | null;
  /** The first ready task the digest names as next. */
  readonly next: boolean;
  /** The task's failed latest run, which the Needs you block offers Retry on. */
  readonly failed: WorkstreamDto | null;
  /** Whether `retryWorkstream` would accept a retry of `failed`; when not, the row offers no Retry and promises none. */
  readonly retryable: boolean;
  /** The pull request link; a branch several tasks share shows it on its first row only. */
  readonly prUrl: string | null;
  /** Several tasks of the goal share this task's branch. */
  readonly shared: boolean;
  readonly activity: string | null;
  /** Where the task is in the bar. */
  readonly bucket: 'merged' | 'in_review' | 'in_progress' | 'ready' | 'not_started';
  readonly workstream: WorkstreamDto | undefined;
}

export interface TaskRowsInput {
  /** The goal's tasks, in the goal's order. */
  readonly tasks: readonly TaskDto[];
  /** Workstreams of those tasks, any run. */
  readonly workstreams: readonly WorkstreamDto[];
  readonly batches: readonly BatchDto[];
  /** The digest's next task, when it is ready now. */
  readonly nextTaskId: TaskId | null;
  readonly gateCommand: string | null;
}

function latestRuns(workstreams: readonly WorkstreamDto[]): Map<TaskId, WorkstreamDto> {
  const latest = new Map<TaskId, WorkstreamDto>();
  for (const ws of workstreams) {
    const seen = latest.get(ws.taskId);
    if (!seen || seen.createdAt <= ws.createdAt) latest.set(ws.taskId, ws);
  }
  return latest;
}

function runningStep(ws: WorkstreamDto): string {
  const step = ws.steps[ws.stepIndex];
  if (!step) return `Building · ${ws.model}`;
  return `${STEP_LABEL[step.role]} ${String(ws.stepIndex + 1)}/${String(ws.steps.length)} · ${step.model}`;
}

/**
 * Where a task sits in the bar, taken from its Board column so Factory and the Board agree. The
 * task's status cannot say it: the daemon marks a shipped task done while its pull request is
 * still open (In review) or its batch still ships (In progress), and a task whose run was
 * cancelled goes back to Ready or Backlog with that run still its latest.
 */
const BUCKET: Readonly<Record<BoardStatus, TaskRow['bucket']>> = {
  [BoardStatus.Done]: 'merged',
  [BoardStatus.InReview]: 'in_review',
  [BoardStatus.InProgress]: 'in_progress',
  [BoardStatus.Blocked]: 'in_progress',
  [BoardStatus.Ready]: 'ready',
  [BoardStatus.Backlog]: 'not_started',
};

/**
 * The goal's task list: one row per task that is not cancelled, each with its state said once. The
 * state is the Board card's own line (`taskState`), shortened where the row has a better place for
 * it: a failure is said in Needs you, a step only on a row that is running.
 */
export function taskRows(input: TaskRowsInput): TaskRow[] {
  const runs = latestRuns(input.workstreams);
  const batchById = new Map(input.batches.map((b) => [b.id, b] as const));
  const open = input.tasks.filter((t) => t.status !== TaskStatus.Cancelled);
  const unmet = (task: TaskDto): number =>
    task.dependsOn.filter((id) => {
      const dep = open.find((t) => t.id === id);
      return dep !== undefined && dep.boardStatus !== BoardStatus.Done;
    }).length;

  // The batches several of the goal's tasks share, and the first row of each, which holds the link.
  const perBatch = new Map<string, number>();
  for (const task of open) {
    const batchId = runs.get(task.id)?.batchId;
    if (batchId) perBatch.set(batchId, (perBatch.get(batchId) ?? 0) + 1);
  }
  const linked = new Set<string>();

  return open.map((task): TaskRow => {
    const ws = runs.get(task.id);
    const batch = ws?.batchId ? batchById.get(ws.batchId) : undefined;
    const bucket = BUCKET[task.boardStatus];
    const label = task.headline || task.title;
    const next = bucket === 'ready' && task.id === input.nextTaskId;
    const shared = ws?.batchId ? (perBatch.get(ws.batchId) ?? 0) > 1 : false;
    let prUrl: string | null = null;
    if (batch?.prUrl && !(ws?.batchId && linked.has(ws.batchId))) {
      prUrl = batch.prUrl;
      if (ws?.batchId) linked.add(ws.batchId);
    }
    const common = {
      taskId: task.id,
      label,
      next,
      prUrl,
      shared,
      bucket,
      workstream: ws,
      activity: ws?.lastActivityAt ?? null,
    };

    // A task with no run, or one whose run ended without finishing it (cancelled), is said by its
    // column alone; the old run's state would contradict the Board.
    if (!ws || bucket === 'ready' || bucket === 'not_started') {
      const waits = unmet(task);
      const state =
        bucket === 'ready'
          ? next
            ? 'Ready · next'
            : 'Ready'
          : waits > 0
            ? `Waits on ${String(waits)}`
            : 'Not started';
      return {
        ...common,
        color: 'gray',
        state,
        detail: null,
        running: null,
        failed: null,
        retryable: false,
      };
    }
    if (RUNNING_STATES.has(ws.state)) {
      const step = runningStep(ws);
      return {
        ...common,
        color: 'blue',
        state: step,
        detail: null,
        running: { step, contextPct: ws.contextPct },
        failed: null,
        retryable: false,
      };
    }
    if (ws.state === S.Failed && !(batch?.prUrl && batch.state === 'SHIPPED')) {
      return {
        ...common,
        color: 'red',
        state: 'Failed',
        detail: ws.failureReason,
        running: null,
        failed: ws,
        retryable: canRetryRun(task, ws, batch),
      };
    }
    const said = taskState(ws, batch, input.gateCommand, undefined, input.batches, task);
    const failed = ws.state === S.Failed ? ws : null;
    let state: string;
    let color: MantineColor = said?.color ?? 'gray';
    if (said) {
      state = bucket === 'in_review' ? `In review · ${said.line}` : said.line;
    } else if (bucket === 'merged') {
      state = ws.batchId ? 'Merged' : 'Done';
      color = 'green';
    } else {
      state = bucket === 'in_review' ? 'In review' : 'In progress';
    }
    return {
      ...common,
      color,
      state,
      detail: said?.detail ?? null,
      running: null,
      failed,
      retryable: failed !== null && canRetryRun(task, failed, batch),
    };
  });
}

export interface BarCounts {
  readonly merged: number;
  readonly inReview: number;
  readonly inProgress: number;
  readonly ready: number;
  readonly notStarted: number;
  readonly total: number;
}

/**
 * The bar's segments: merged and in review as the daemon counts them, the rest of the not-cancelled
 * tasks split by their rows. A task whose row has not loaded yet counts as not started.
 */
export function barCounts(progress: GoalProgress, rows: readonly TaskRow[]): BarCounts {
  const inProgress = rows.filter((r) => r.bucket === 'in_progress').length;
  const ready = rows.filter((r) => r.bucket === 'ready').length;
  const rest = Math.max(0, progress.total - progress.merged - progress.inReview);
  return {
    merged: progress.merged,
    inReview: progress.inReview,
    inProgress: Math.min(inProgress, rest),
    ready: Math.min(ready, Math.max(0, rest - inProgress)),
    notStarted: Math.max(0, rest - inProgress - ready),
    total: progress.total,
  };
}

/** "Implementer opus@high, sonnet@medium · Reviewer opus@medium": each persona once, then its profiles. */
export function teamLine(team: readonly DigestTeamMember[]): string {
  const byPersona = new Map<string, string[]>();
  for (const member of team) {
    const profile = `${member.model}@${member.effort}`;
    const seen = byPersona.get(member.persona) ?? [];
    if (!seen.includes(profile)) seen.push(profile);
    byPersona.set(member.persona, seen);
  }
  return [...byPersona]
    .map(([persona, profiles]) => `${persona} ${profiles.join(', ')}`)
    .join(' · ');
}
