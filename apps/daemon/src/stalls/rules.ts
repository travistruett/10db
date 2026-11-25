import {
  BatchState,
  isTerminal,
  QueueWaitKind,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type ProjectId,
  type QueueWait,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { STALL, UNCOUNTED_WAITS } from './thresholds';

/** The ways out a Stuck card offers, as its option labels. */
export const StallAction = {
  CancelRun: 'Cancel Run',
  RetryDependency: 'Retry Dependency',
  CancelWaiting: 'Cancel Waiting Tasks',
  AbandonBatch: 'Abandon Batch',
} as const;
export type StallAction = (typeof StallAction)[keyof typeof StallAction];

export interface QueuedRun {
  readonly run: Pick<WorkstreamDto, 'id' | 'projectId' | 'taskId' | 'batchId' | 'state'>;
  readonly title: string;
  readonly wait: QueueWait;
}

export type ActiveRun = Pick<
  WorkstreamDto,
  'id' | 'projectId' | 'taskTitle' | 'state' | 'lastActivityAt' | 'updatedAt'
>;

export interface BatchMembers {
  readonly batch: Pick<BatchDto, 'id' | 'projectId' | 'title' | 'state' | 'updatedAt'> & {
    readonly passId?: BatchDto['passId'];
  };
  /** The latest run of each task in the batch. */
  readonly members: readonly Pick<WorkstreamDto, 'id' | 'state'>[];
}

export interface StallInput {
  readonly now: Date;
  readonly queued: readonly QueuedRun[];
  /** The STARTING, RUNNING and VERIFYING runs. */
  readonly active: readonly ActiveRun[];
  readonly batches: readonly BatchMembers[];
  /** The `since` each open Stuck card already says, by its key: a restart keeps the count. */
  readonly carried: ReadonlyMap<string, string>;
}

export interface Stall {
  readonly key: string;
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId | null;
  readonly batchId: BatchId | null;
  readonly title: string;
  readonly reason: string;
  readonly since: string;
  /** What the card says apart from the time: a card whose fingerprint differs is written again. */
  readonly fingerprint: string;
  readonly actions: readonly StallAction[];
  /** The failed run Retry Dependency retries. */
  readonly dependencyRunId: WorkstreamId | null;
  /** The queued runs Cancel Waiting Tasks cancels. */
  readonly waitingRunIds: readonly WorkstreamId[];
}

export const runStallKey = (id: WorkstreamId): string => `stuck:run:${id}`;
export const batchStallKey = (id: BatchId): string => `stuck:batch:${id}`;

const ACTIVE: ReadonlySet<string> = new Set([
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.Verifying,
]);
const MOVING_BATCH: ReadonlySet<string> = new Set([BatchState.Shipping, BatchState.Cutting]);

/** Every stall in `input`, one per stuck run or batch. Pure: it reads nothing and writes nothing. */
export function findStalls(input: StallInput): Stall[] {
  const now = input.now.getTime();
  const older = (at: string, ms: number): boolean => now - Date.parse(at) > ms;
  const earliest = (key: string, at: string): string => {
    const carried = input.carried.get(key);
    return carried !== undefined && Date.parse(carried) < Date.parse(at) ? carried : at;
  };
  const stall = (s: Omit<Stall, 'fingerprint' | 'since'> & { since: string }): Stall => ({
    ...s,
    since: earliest(s.key, s.since),
    fingerprint: [s.title, s.reason, s.actions.join(',')].join('\n'),
  });

  const runStalls = new Map<WorkstreamId, Stall>();
  for (const { run, title, wait } of input.queued) {
    const counts =
      wait.endless || (!UNCOUNTED_WAITS.has(wait.kind) && older(wait.since, STALL.queuedMs));
    if (!counts) continue;
    const retry = wait.kind === QueueWaitKind.Dependency ? (wait.on?.workstreamId ?? null) : null;
    const abandon = wait.kind === QueueWaitKind.Copy && wait.endless && run.batchId !== null;
    runStalls.set(
      run.id,
      stall({
        key: runStallKey(run.id),
        projectId: run.projectId,
        workstreamId: run.id,
        batchId: run.batchId,
        title,
        reason: wait.endless
          ? `It is queued, waiting ${wait.line}. That can't happen by itself.`
          : `It is queued, waiting ${wait.line}.`,
        since: wait.since,
        actions: [
          StallAction.CancelRun,
          ...(retry !== null ? [StallAction.RetryDependency] : []),
          ...(abandon ? [StallAction.AbandonBatch] : []),
        ],
        dependencyRunId: retry,
        waitingRunIds: [run.id],
      }),
    );
  }

  const stalls: Stall[] = [];
  const folded = new Set<WorkstreamId>();
  for (const { batch, members } of input.batches) {
    if (batch.state === BatchState.Open && (batch.passId ?? null) === null) {
      const unfinished = members.filter((m) => !isTerminal(m.state));
      const stuck = unfinished.flatMap((m) => {
        const s = runStalls.get(m.id);
        return m.state === WorkstreamState.Queued && s ? [s] : [];
      });
      if (unfinished.length === 0 || stuck.length !== unfinished.length) continue;
      for (const m of unfinished) folded.add(m.id);
      const finished = members.length - unfinished.length;
      stalls.push(
        stall({
          key: batchStallKey(batch.id),
          projectId: batch.projectId,
          workstreamId: null,
          batchId: batch.id,
          title: batch.title,
          reason: [
            `${String(finished)} of ${String(members.length)} tasks are finished; the rest can't start:`,
            ...stuck.map((s) => `- ${s.title}: ${s.reason}`),
          ].join('\n'),
          since: stuck
            .map((s) => s.since)
            .reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)),
          actions: [StallAction.CancelWaiting, StallAction.AbandonBatch],
          dependencyRunId: null,
          waitingRunIds: unfinished.map((m) => m.id),
        }),
      );
    } else if (MOVING_BATCH.has(batch.state) && older(batch.updatedAt, STALL.batchMovingMs)) {
      stalls.push(
        stall({
          key: batchStallKey(batch.id),
          projectId: batch.projectId,
          workstreamId: null,
          batchId: batch.id,
          title: batch.title,
          reason:
            batch.state === BatchState.Cutting
              ? 'Its copy is still being cut.'
              : 'It is still shipping.',
          since: batch.updatedAt,
          actions: [StallAction.AbandonBatch],
          dependencyRunId: null,
          waitingRunIds: [],
        }),
      );
    }
  }
  for (const [id, s] of runStalls) if (!folded.has(id)) stalls.push(s);

  for (const run of input.active) {
    if (!ACTIVE.has(run.state)) continue;
    const at = run.lastActivityAt ?? run.updatedAt;
    if (!older(at, STALL.activeIdleMs)) continue;
    stalls.push(
      stall({
        key: runStallKey(run.id),
        projectId: run.projectId,
        workstreamId: run.id,
        batchId: null,
        title: run.taskTitle,
        reason: `It is ${run.state.toLowerCase()} but has shown no activity.`,
        since: at,
        actions: [StallAction.CancelRun],
        dependencyRunId: null,
        waitingRunIds: [],
      }),
    );
  }
  return stalls;
}
