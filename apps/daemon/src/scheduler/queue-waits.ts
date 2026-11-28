import {
  BatchState,
  EventType,
  QUEUE_WAIT_LINE_MAX,
  QueueWaitKind,
  type BatchDto,
  type QueueWait,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import type { DependencyWait } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';

/** A wait as the scheduler finds it on a tick; `since` is kept by the store. */
export type FoundWait = Omit<QueueWait, 'since'>;

/**
 * What each queued run waits for, as the scheduler's last tick found it. Held in memory: a restart
 * forgets it, and the first tick after finds it again. A wait keeps its `since` while its kind, what it
 * waits on and whether it can end stay the same.
 */
export interface QueueWaits {
  record(id: WorkstreamId, wait: FoundWait): void;
  get(id: WorkstreamId): QueueWait | undefined;
  /** Forgets every run but these: the ones still queued and not launched. */
  retain(ids: Iterable<WorkstreamId>): void;
  /** Emits one `workstream.wait_changed` per run whose wait said something new since the last flush. */
  flush(): void;
}

export function createQueueWaits(deps: {
  readonly state: StateStore;
  readonly clock: Clock;
}): QueueWaits {
  const waits = new Map<WorkstreamId, QueueWait>();
  const changed = new Set<WorkstreamId>();

  return {
    record(id, found) {
      const wait = { ...found, line: fit(found.line) };
      const before = waits.get(id);
      const same =
        before?.kind === wait.kind &&
        before.endless === wait.endless &&
        before.on?.taskId === wait.on?.taskId &&
        before.on?.workstreamId === wait.on?.workstreamId;
      const since = same ? before.since : deps.clock.now().toISOString();
      if (before?.kind !== wait.kind || before.line !== wait.line || !same) changed.add(id);
      waits.set(id, { ...wait, since });
    },
    get: (id) => waits.get(id),
    retain(ids) {
      const keep = new Set(ids);
      for (const id of waits.keys()) if (!keep.has(id)) waits.delete(id);
      for (const id of changed) if (!keep.has(id)) changed.delete(id);
    },
    flush() {
      if (changed.size === 0) return;
      const ids = [...changed];
      changed.clear();
      deps.state.write((ctx) => {
        for (const id of ids)
          ctx.emit({
            type: EventType.WorkstreamWaitChanged,
            entityType: 'workstream',
            entityId: id,
            data: { wait: waits.get(id) ?? null },
          });
      });
    },
  };
}

function fit(line: string): string {
  return line.length <= QUEUE_WAIT_LINE_MAX ? line : `${line.slice(0, QUEUE_WAIT_LINE_MAX - 1)}…`;
}

/** The batch states a run's batch never opens from, so a run waiting in it waits for ever. */
const ENDED_BATCH: ReadonlySet<string> = new Set([
  BatchState.Failed,
  BatchState.Abandoned,
  BatchState.Shipped,
  BatchState.Closed,
]);

/** The plain words of each wait the scheduler records, with whether it can end by itself. */
export const queueWait = {
  lane: (): FoundWait => ({
    kind: QueueWaitKind.Lane,
    line: 'for a free lane',
    endless: false,
    on: null,
  }),
  machine: (): FoundWait => ({
    kind: QueueWaitKind.Machine,
    line: 'for the Mac to be less busy',
    endless: false,
    on: null,
  }),
  account: (why: 'signing in' | 'reading its models' | 'not ready' | 'blocked'): FoundWait => ({
    kind: QueueWaitKind.Account,
    line:
      why === 'blocked'
        ? 'for its account, which is paused or over its limit'
        : `for its account, which is ${why}`,
    endless: false,
    on: null,
  }),
  folder: (holders: string): FoundWait => ({
    kind: QueueWaitKind.Folder,
    line: `for ${holders} to finish with Your folder`,
    endless: false,
    on: null,
  }),
  pass: (line: string): FoundWait => ({
    kind: QueueWaitKind.Pass,
    line,
    endless: false,
    on: null,
  }),
  checkout: (line: string): FoundWait => ({
    kind: QueueWaitKind.Checkout,
    line,
    endless: false,
    on: null,
  }),
  /**
   * The run's batch is not open with its copy made: still being cut, or over for good. `ahead` names
   * the copy in progress when the batch's copy waits its turn, which no cut has begun for.
   */
  copy: (batch: BatchDto | null, ahead?: { readonly title: string } | null): FoundWait => {
    const ended = batch !== null && ENDED_BATCH.has(batch.state);
    const turn =
      ahead === undefined
        ? null
        : ahead === null
          ? 'for its turn to be cut as the next copy'
          : `for the copy in progress (${ahead.title}) to ship or be abandoned, then its turn as the next copy`;
    return {
      kind: QueueWaitKind.Copy,
      line: ended
        ? `on a batch that is ${batch.state.toLowerCase()} and will not open again`
        : (turn ?? 'for its batch to open'),
      endless: ended,
      on: null,
    };
  },
  parked: (): FoundWait => ({
    kind: QueueWaitKind.Parked,
    line: 'for you to move it out of the column you parked it in',
    endless: false,
    on: null,
  }),
  keptWork: (): FoundWait => ({
    kind: QueueWaitKind.KeptWork,
    line: 'for its saved Workbench work to go back in Your folder',
    endless: false,
    on: null,
  }),
  /**
   * The first dependency that can't finish, else the first that waits. One that waits for its copy to
   * land in the run's own batch waits for this run: the copy lands only once this run is done.
   */
  dependency: (deps: readonly DependencyWait[], ownBatch: string | null): FoundWait | null => {
    const stuck = (d: DependencyWait): boolean =>
      d.ended !== null || (d.landing && d.landingBatchId !== null && d.landingBatchId === ownBatch);
    const dep = deps.find(stuck) ?? deps[0];
    if (dep === undefined) return null;
    const line =
      dep.ended === 'cancelled'
        ? `for ${dep.title}, which was cancelled`
        : dep.ended === 'failed'
          ? `for ${dep.title}, which failed`
          : dep.landing
            ? dep.landingBatchId === ownBatch
              ? `for ${dep.title}'s copy to land, which waits for this task`
              : `for ${dep.title}'s copy to land`
            : `for ${dep.title} to finish`;
    return {
      kind: QueueWaitKind.Dependency,
      line,
      endless: stuck(dep),
      on: { taskId: dep.taskId, workstreamId: dep.failedRunId },
    };
  },
  claim: (input: {
    readonly name: string;
    readonly holderTitle: string;
    readonly holder: { readonly taskId: TaskId; readonly workstreamId: WorkstreamId };
    readonly holderEnded: boolean;
  }): FoundWait => ({
    kind: QueueWaitKind.Claim,
    line: input.holderEnded
      ? `for ${input.name}, still held by ${input.holderTitle}, which has finished`
      : `for ${input.holderTitle} to finish with ${input.name}`,
    endless: input.holderEnded,
    on: input.holder,
  }),
  /** 10db's own work for the project reached today's ceiling; it starts tomorrow or on Carry On Today. */
  ceiling: (): FoundWait => ({
    kind: QueueWaitKind.Ceiling,
    line: "for tomorrow: this project's own work reached today's ceiling",
    endless: false,
    on: null,
  }),
  /** Queued behind the task it deadlocked with twice, until that task ends or frees what they fought over. */
  turn: (input: {
    readonly title: string;
    readonly on: { readonly taskId: TaskId; readonly workstreamId: WorkstreamId };
  }): FoundWait => ({
    kind: QueueWaitKind.Turn,
    line: `Waits its turn behind "${input.title}", which it deadlocked with twice`,
    endless: false,
    on: input.on,
  }),
} as const;
