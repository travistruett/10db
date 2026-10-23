import type { TaskId } from './ids';
import {
  BatchState as B,
  WorkstreamState as S,
  type BatchState,
  type WorkstreamState,
} from './states';

/** Allowed batch transitions (batch delivery spec §4). A refused CUTTING row is deleted, not moved. */
export const BATCH_TRANSITIONS: Readonly<Record<BatchState, readonly BatchState[]>> = {
  [B.Cutting]: [B.Open],
  [B.Open]: [B.Shipping, B.Failed, B.Abandoned],
  [B.Shipping]: [B.Shipped, B.Closed, B.Failed],
  [B.Failed]: [B.Shipping, B.Open, B.Abandoned],
  [B.Shipped]: [],
  [B.Closed]: [],
  [B.Abandoned]: [],
};

export function canBatchTransition(from: BatchState, to: BatchState): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

/** A project has at most one batch in these states; the database's partial unique index lists the same four. */
export const UNFINISHED_BATCH_STATES: readonly BatchState[] = [
  B.Cutting,
  B.Open,
  B.Shipping,
  B.Failed,
];

export const ShipReadiness = {
  Ready: 'ready',
  ShipAnyway: 'ship_anyway',
  Blocked: 'blocked',
} as const;
export type ShipReadiness = (typeof ShipReadiness)[keyof typeof ShipReadiness];

const SETTLED: readonly WorkstreamState[] = [S.Done, S.Cancelled];

/** A workstream in one of these states no longer holds its batch open. */
export function isSettled(state: WorkstreamState): boolean {
  return SETTLED.includes(state);
}

/**
 * Whether a batch's members let it ship: all settled ships by itself; settled or failed needs the
 * builder's "Ship anyway"; anything else (running, queued, waiting, paused) blocks it.
 */
export function shipReadiness(states: readonly WorkstreamState[]): ShipReadiness {
  if (states.every(isSettled)) return ShipReadiness.Ready;
  if (states.every((s) => isSettled(s) || s === S.Failed)) return ShipReadiness.ShipAnyway;
  return ShipReadiness.Blocked;
}

/** A batch member is a task's latest workstream in it; `rows` come oldest first. */
export function latestPerTask<T extends { readonly taskId: TaskId }>(rows: readonly T[]): T[] {
  const last = new Map<TaskId, T>();
  for (const row of rows) last.set(row.taskId, row);
  return [...last.values()];
}
