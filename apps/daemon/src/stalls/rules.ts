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
import { STALL, STALL_MINUTE_MS, UNCOUNTED_WAITS } from './thresholds';

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

/** A run's gate process that is running now, as the sweep saw it. */
export interface LiveGate {
  /** When the gate's process started. */
  readonly startedAt: string;
  /** When its log last grew. */
  readonly lastOutputAt: string;
  /** How long the gate may run before 10db stops it. */
  readonly timeoutMs: number;
}

export type ActiveRun = Pick<
  WorkstreamDto,
  'id' | 'projectId' | 'taskTitle' | 'state' | 'lastActivityAt' | 'updatedAt'
> & {
  /** Set while the run has a gate process running: its output counts as the run's activity. */
  readonly gate?: LiveGate;
};

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
  /**
   * Silence is counted from here at the earliest: the later of the daemon's start and the last moment
   * 10db's own admission held new work. Time before it was spent down or waiting on 10db, not stuck.
   */
  readonly countFrom: Date;
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

/** `ms` as whole minutes: "1 minute", "25 minutes". */
function minutes(ms: number): string {
  const n = Math.round(ms / STALL_MINUTE_MS);
  return `${String(n)} ${n === 1 ? 'minute' : 'minutes'}`;
}

/**
 * What a Stuck card says of a run's live gate. Both sentences hold whenever the card is read: they name
 * the span the gate wrote for, or its fixed limit, never the time since.
 */
function gateNote(gate: LiveGate | undefined, counts: boolean): string {
  if (gate === undefined) return '';
  if (!counts) return ` Its gate has run past its limit of ${minutes(gate.timeoutMs)}.`;
  const wrote = Date.parse(gate.lastOutputAt) - Date.parse(gate.startedAt);
  return wrote < STALL_MINUTE_MS
    ? ' Its gate has printed nothing since it started.'
    : ` Its gate ran for ${minutes(wrote)} and then printed nothing.`;
}

/** Every stall in `input`, one per stuck run or batch. Pure: it reads nothing and writes nothing. */
export function findStalls(input: StallInput): Stall[] {
  const now = input.now.getTime();
  const older = (at: string, ms: number): boolean => now - Date.parse(at) > ms;
  /** `at`, or `countFrom` when the silence began before it. */
  const counted = (at: string): string =>
    Date.parse(at) < input.countFrom.getTime() ? input.countFrom.toISOString() : at;
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
    } else if (
      MOVING_BATCH.has(batch.state) &&
      older(counted(batch.updatedAt), STALL.batchMovingMs)
    ) {
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
          since: counted(batch.updatedAt),
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
    const { gate } = run;
    // A gate still inside its own limit is the run's activity: the gate's output moves the clock.
    const gateCounts = gate !== undefined && now - Date.parse(gate.startedAt) <= gate.timeoutMs;
    const own = counted(run.lastActivityAt ?? run.updatedAt);
    const at =
      gate !== undefined && gateCounts && Date.parse(gate.lastOutputAt) > Date.parse(own)
        ? counted(gate.lastOutputAt)
        : own;
    if (!older(at, STALL.activeIdleMs)) continue;
    stalls.push(
      stall({
        key: runStallKey(run.id),
        projectId: run.projectId,
        workstreamId: run.id,
        batchId: null,
        title: run.taskTitle,
        reason: `It is ${run.state.toLowerCase()} but has shown no activity.${gateNote(gate, gateCounts)}`,
        since: at,
        actions: [StallAction.CancelRun],
        dependencyRunId: null,
        waitingRunIds: [],
      }),
    );
  }
  return stalls;
}
