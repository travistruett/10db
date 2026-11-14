import type { AccountId, PassId, ProjectId } from '@10db/contracts';
import type { LaneCounts } from '@10db/db';

/** Where a lane would run and the limits it is held to. */
export interface LaneAsk {
  readonly projectId: ProjectId;
  readonly accountId: AccountId;
  /** The pass the task is in, with its page cap; null for a task outside every pass. */
  readonly pass: { readonly id: PassId; readonly pageCap: number } | null;
  /** The daemon-wide cap, the project's `maxLanes` and the account's lane limit. */
  readonly global: number;
  readonly maxLanes: number;
  readonly accountCap: number;
}

/**
 * Whether one more lane fits (Workbench spec §5.2, W11). Every lane counts against the daemon-wide
 * cap and its account's limit. A pass's lanes are left out of their project's `maxLanes` and held to
 * the pass's page cap instead; any other lane is held to its project's `maxLanes`.
 */
export function roomForLane(counts: LaneCounts, ask: LaneAsk): boolean {
  if (counts.global >= ask.global) return false;
  if ((counts.byAccount.get(ask.accountId) ?? 0) >= ask.accountCap) return false;
  if (ask.pass !== null) return (counts.byPass.get(ask.pass.id) ?? 0) < ask.pass.pageCap;
  return (counts.byProject.get(ask.projectId) ?? 0) < ask.maxLanes;
}
