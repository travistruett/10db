import { type InboxItemId, type WorkstreamId, WorkstreamState } from '@10db/contracts';
import {
  activeClaims,
  getProject,
  getTask,
  getTaskStartDirt,
  getWorkstreamRow,
  passAreasOf,
  passHoldingTask,
  releaseClaim,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import { checkoutOf } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { findClaimed } from '../watcher';
import { withoutStartDirt } from './start-dirt';

/**
 * The paths in the claims the workstream holds right now that git reports as changed, less those
 * still exactly as the checkout held them when the task first launched.
 */
export async function claimedChanges(
  db: DbReader,
  git: Pick<Git, 'changedPaths'>,
  row: WorkstreamRow,
): Promise<string[]> {
  const project = getProject(db, row.projectId);
  const checkout = checkoutOf(db, row);
  const changed = await git.changedPaths(checkout);
  const claims = activeClaims(db, row.id).map((c) => ({ kind: c.kind, name: c.name }));
  // A pass lane's claims name the pass's own areas: the whole-project page for a pass of one.
  const pass = passHoldingTask(db, getTask(db, row.taskId));
  const areas = pass ? [...passAreasOf(db, pass.id)] : project.areas;
  const claimed = findClaimed(changed, { areas, hazards: project.hazards }, claims);
  const start = pass ? null : getTaskStartDirt(db, row.taskId);
  return withoutStartDirt(claimed, checkout, start).sort();
}

/**
 * A workstream parked on a question to a person lets go of the claims in which its checkout holds
 * nothing uncommitted, so the people it waits for do not stall the tasks that need the same areas;
 * the scheduler asks for them again, like any queued task's, when the answer requeues it. A claim
 * that covers an edit the task left uncommitted is kept: those edits stay the waiting task's, so no
 * other task can touch or commit them, while the rest of a wide area is free. A pass's page holds its
 * pass's areas for the pass's life and never lets go. Answers whether any claim was released.
 */
export async function yieldClaimsWhileWaiting(
  deps: { readonly state: StateStore; readonly git: Pick<Git, 'changedPaths'> },
  id: WorkstreamId,
  inboxId: InboxItemId,
): Promise<boolean> {
  const db = deps.state.db;
  const waiting = (row: WorkstreamRow): boolean =>
    row.state === WorkstreamState.WaitingHuman &&
    row.currentSessionId === null &&
    row.nextAction.kind === 'answer' &&
    row.nextAction.inboxId === inboxId;
  const before = getWorkstreamRow(db, id);
  if (!waiting(before) || passHoldingTask(db, getTask(db, before.taskId))) return false;
  const project = getProject(db, before.projectId);
  // A checkout git can't read is not known to be clean: nothing is released.
  const dirty = await claimedChanges(db, deps.git, before).catch(() => null);
  if (dirty === null) return false;
  return deps.state.write((ctx) => {
    // The answer, a stop or a restart may have moved it while git was read.
    if (!waiting(getWorkstreamRow(ctx.tx, id))) return false;
    let released = false;
    for (const claim of activeClaims(ctx.tx, id)) {
      const covers = findClaimed(dirty, { areas: project.areas, hazards: project.hazards }, [
        { kind: claim.kind, name: claim.name },
      ]);
      if (covers.length === 0 && releaseClaim(ctx, claim.id)) released = true;
    }
    return released;
  });
}
