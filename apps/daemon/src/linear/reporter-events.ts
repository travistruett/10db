import {
  BatchId,
  BatchState,
  EventType,
  ExternalKind,
  InboxItemId,
  LinearEventKind,
  PullRequestState,
  WorkstreamId,
  WorkstreamState,
  type DaemonEvent,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import {
  enqueueLinearPost,
  getBatch,
  getInboxItem,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  listLinearPosts,
  listWorkstreams,
  pendingLinearPosts,
  type DbReader,
  type Json,
} from '@10db/db';
import type { Clock } from '../clock';
import type { EventBus, StateStore } from '../events';
import type { Logger } from '../log';
import { trustSwitchesFor } from '../permissions';
import { reporterSettings } from './reporter-settings';

/** How long an event waits before it is posted, so a burst becomes one update. */
export const REPORT_DELAY_MS = 30_000;

/** One update an event makes: the row's task, kind, key and what it was. */
export interface LinearRowDraft {
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  readonly event: LinearEventKind;
  readonly dedupeKey: string;
  readonly detail: Record<string, Json>;
}

/** What the listener read from the rows for one event; each part is read only for the event that needs it. */
export interface LinearEventRead {
  /** The event's workstream; `ends` is how many Ended rows it already has. */
  readonly workstream?: {
    readonly id: WorkstreamId;
    readonly taskId: TaskId;
    readonly failureKind: string | null;
    readonly ends: number;
    /** The `at` of the result the step recorded. */
    readonly stepResultAt: string | null;
  };
  /** The Inbox item an `inbox.opened` names, with the workstreams its targets point at. */
  readonly inbox?: {
    readonly title: string;
    readonly workstreams: readonly { readonly id: WorkstreamId; readonly taskId: TaskId }[];
  };
  /** The batch a `batch.updated` names, its workstreams and its pull request. */
  readonly batch?: {
    readonly prUrl: string | null;
    readonly prState: string | null;
    readonly workstreams: readonly { readonly id: WorkstreamId; readonly taskId: TaskId }[];
  };
}

const ENDED: ReadonlySet<unknown> = new Set([
  WorkstreamState.Done,
  WorkstreamState.Failed,
  WorkstreamState.Cancelled,
]);

function text(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** Pure: which rows one event makes, from the event and what the listener read for it. */
export function linearRowOf(event: DaemonEvent, read: LinearEventRead): LinearRowDraft[] {
  const data = event.data;
  const ws = read.workstream;
  if (event.type === EventType.WorkstreamChanged) {
    if (ws === undefined) return [];
    const to = data['to'];
    if (to === WorkstreamState.Starting) {
      return [
        {
          taskId: ws.taskId,
          workstreamId: ws.id,
          event: LinearEventKind.RunStarted,
          dedupeKey: `run_started:${ws.id}:${String(ws.ends)}`,
          detail: { workstreamId: ws.id, from: text(data['from']), reason: text(data['reason']) },
        },
      ];
    }
    if (typeof to === 'string' && ENDED.has(to)) {
      return [
        {
          taskId: ws.taskId,
          workstreamId: ws.id,
          event: LinearEventKind.Ended,
          dedupeKey: `ended:${ws.id}:${String(ws.ends)}`,
          detail: {
            workstreamId: ws.id,
            to,
            failureKind: ws.failureKind,
            reason: text(data['reason']),
          },
        },
      ];
    }
    return [];
  }
  if (event.type === EventType.InboxOpened) {
    if (read.inbox === undefined) return [];
    const { title } = read.inbox;
    return read.inbox.workstreams.map((w) => ({
      taskId: w.taskId,
      workstreamId: w.id,
      event: LinearEventKind.Waiting,
      dedupeKey: `waiting:${event.entityId}`,
      detail: { workstreamId: w.id, title, kind: text(data['kind']) },
    }));
  }
  if (event.type === EventType.StepChanged) {
    const verdict = data['verdict'];
    if (ws === undefined || typeof verdict !== 'string') return [];
    const stepIndex = data['stepIndex'];
    return [
      {
        taskId: ws.taskId,
        workstreamId: ws.id,
        event: LinearEventKind.Verdict,
        dedupeKey: `verdict:${ws.id}:${String(typeof stepIndex === 'number' ? stepIndex : -1)}:${ws.stepResultAt ?? event.at}`,
        detail: {
          workstreamId: ws.id,
          stepIndex: typeof stepIndex === 'number' ? stepIndex : null,
          role: text(data['role']),
          verdict,
        },
      },
    ];
  }
  if (event.type === EventType.BatchUpdated) {
    const batch = read.batch;
    if (batch === undefined) return [];
    const changed = data['changed'];
    const merged =
      Array.isArray(changed) && changed.includes('pr') && batch.prState === PullRequestState.Merged;
    const shipped = data['to'] === BatchState.Shipped;
    if (!merged && !shipped) return [];
    const kind = merged ? LinearEventKind.PrMerged : LinearEventKind.PrOpened;
    const prefix = merged ? 'pr_merged' : 'pr_opened';
    return batch.workstreams.map((w) => ({
      taskId: w.taskId,
      workstreamId: w.id,
      event: kind,
      dedupeKey: `${prefix}:${event.entityId}`,
      detail: { workstreamId: w.id, prUrl: batch.prUrl },
    }));
  }
  return [];
}

/** The run's number among the task's runs (workstreams by creation), from 1. A Retry reuses its workstream. */
export function attemptOf(db: DbReader, workstreamId: WorkstreamId): number {
  const row = getWorkstreamRow(db, workstreamId);
  const runs = listWorkstreams(db, { projectId: row.projectId }).filter(
    (w) => w.taskId === row.taskId,
  );
  return Math.max(1, runs.findIndex((w) => w.id === workstreamId) + 1);
}

/** Why the project doesn't report (switched off, Your MCP servers off), or null. */
export function reporterBlockedBy(db: DbReader, projectId: ProjectId): string | null {
  if (!reporterSettings(db, projectId).on) return 'Off: Report To Linear is off.';
  if (!trustSwitchesFor(db, projectId, () => undefined).yourMcpServers)
    return 'Off: Your MCP servers is off in Trust.';
  return null;
}

/** How many Ended rows the workstream already has: a Retry's end comes after one, a re-entry has none between. */
function endsOf(db: DbReader, taskId: TaskId, workstreamId: WorkstreamId): number {
  return listLinearPosts(db, taskId).filter(
    (p) => p.event === LinearEventKind.Ended && p.detail['workstreamId'] === workstreamId,
  ).length;
}

function readFor(db: DbReader, event: DaemonEvent): LinearEventRead {
  if (event.type === EventType.WorkstreamChanged || event.type === EventType.StepChanged) {
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return {};
    const ws = getWorkstream(db, id.data);
    const stepIndex = event.data['stepIndex'];
    const result = typeof stepIndex === 'number' ? ws.steps[stepIndex]?.result : undefined;
    return {
      workstream: {
        id: ws.id,
        taskId: ws.taskId,
        failureKind: ws.failureKind,
        ends: endsOf(db, ws.taskId, ws.id),
        stepResultAt: result?.at ?? null,
      },
    };
  }
  if (event.type === EventType.InboxOpened) {
    const itemId = InboxItemId.safeParse(event.entityId);
    if (!itemId.success) return {};
    const item = getInboxItem(db, itemId.data);
    return {
      inbox: {
        title: item.title,
        workstreams: item.targets.flatMap((t) => {
          const ws = getWorkstream(db, t.workstreamId);
          return [{ id: ws.id, taskId: ws.taskId }];
        }),
      },
    };
  }
  if (event.type === EventType.BatchUpdated) {
    const changed = event.data['changed'];
    const relevant =
      event.data['to'] === BatchState.Shipped || (Array.isArray(changed) && changed.includes('pr'));
    if (!relevant) return {};
    const parsed = BatchId.safeParse(event.entityId);
    if (!parsed.success) return {};
    const batchId = parsed.data;
    const batch = getBatch(db, batchId);
    return {
      batch: {
        prUrl: batch.prUrl,
        prState: batch.pr?.state ?? null,
        workstreams: listWorkstreams(db, { batchId }).map((w) => ({
          id: w.id,
          taskId: w.taskId,
        })),
      },
    };
  }
  return {};
}

/**
 * Turns the events of a linked task into owed updates: one `state.write` makes the rows, then the reporter is
 * poked. A project that is not reporting, and a task that is not a Linear link, make none. The listener is
 * synchronous, like the ship trigger's.
 */
export function subscribeLinearEvents(
  bus: EventBus,
  deps: {
    state: StateStore;
    clock: Clock;
    reporter: { poke(taskId: TaskId): void };
    log: Logger;
  },
): () => void {
  const { state, clock, reporter, log } = deps;
  return bus.subscribe((event) => {
    try {
      const drafts = linearRowOf(event, readFor(state.db, event));
      if (drafts.length === 0) return;
      const blocked = new Map<ProjectId, string | null>();
      const poked = state.write((ctx) => {
        const made = new Set<TaskId>();
        for (const draft of drafts) {
          const task = getTask(ctx.tx, draft.taskId);
          if (task.external?.kind !== ExternalKind.Linear) continue;
          if (!blocked.has(task.projectId))
            blocked.set(task.projectId, reporterBlockedBy(ctx.tx, task.projectId));
          if (blocked.get(task.projectId) !== null) continue;
          const row = enqueueLinearPost(ctx, {
            taskId: draft.taskId,
            projectId: task.projectId,
            event: draft.event,
            dedupeKey: draft.dedupeKey,
            attempt: attemptOf(ctx.tx, draft.workstreamId),
            detail: draft.detail,
            dueAt: dueAtFor(ctx.tx, draft.taskId, clock.now().getTime()),
          });
          if (row !== null) made.add(draft.taskId);
        }
        return made;
      });
      for (const taskId of poked) reporter.poke(taskId);
    } catch (error) {
      log.warn({ err: error, type: event.type }, 'a Linear update was not queued');
    }
  });
}

/** A new event waits the report delay, or until a backoff already pending on the task ends, whichever is later. */
function dueAtFor(db: DbReader, taskId: TaskId, nowMs: number): string {
  let due = nowMs + REPORT_DELAY_MS;
  for (const row of pendingLinearPosts(db, { taskId })) {
    const at = row.dueAt === null ? Number.NaN : Date.parse(row.dueAt);
    if (at > due) due = at;
  }
  return new Date(due).toISOString();
}
