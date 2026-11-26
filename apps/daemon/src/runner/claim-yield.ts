import { type InboxItemId, type WorkstreamId, WorkstreamState } from '@10db/contracts';
import {
  activeClaims,
  getProject,
  getTask,
  getTaskStartDirt,
  getWorkstreamRow,
  passAreasOf,
  passHoldingTask,
  forgetGrantedClaimOps,
  releaseClaims,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import { checkoutOf, laneBranchOf } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { findClaimed } from '../watcher';
import { withoutStartDirt } from './start-dirt';

/** What reading a run's uncommitted changes asks of git. */
export type ClaimGit = Pick<Git, 'changedPaths' | 'branchTip' | 'hashOnDisk' | 'blobAt'>;

/**
 * The paths in the claims the workstream holds right now that git reports as changed, less those
 * still exactly as the checkout held them when the task first launched. A run on a lane branch has
 * committed a path the folder holds as the lane's tip does, though it differs from HEAD.
 */
export async function claimedChanges(
  db: DbReader,
  git: ClaimGit,
  row: WorkstreamRow,
): Promise<string[]> {
  const project = getProject(db, row.projectId);
  const checkout = checkoutOf(db, row);
  const changed = await uncommittedOnLane(git, row, checkout, await git.changedPaths(checkout));
  const claims = activeClaims(db, row.id).map((c) => ({ kind: c.kind, name: c.name }));
  // A pass lane's claims name the pass's own areas: the whole-project page for a pass of one.
  const pass = passHoldingTask(db, getTask(db, row.taskId));
  const areas = pass ? [...passAreasOf(db, pass.id)] : project.areas;
  const claimed = findClaimed(changed, { areas, hazards: project.hazards }, claims);
  const start = pass ? null : getTaskStartDirt(db, row.taskId);
  return withoutStartDirt(claimed, checkout, start).sort();
}

/** `changed` less each path the folder holds as the run's lane tip has it; all of it off a lane. */
async function uncommittedOnLane(
  git: ClaimGit,
  row: WorkstreamRow,
  checkout: string,
  changed: readonly string[],
): Promise<string[]> {
  const lane = laneBranchOf(row);
  const tip = lane === null ? null : await git.branchTip(checkout, lane.lane);
  if (tip === null || changed.length === 0) return [...changed];
  const onDisk = new Map((await git.hashOnDisk(checkout, changed)).map((e) => [e.path, e.blob]));
  const left: string[] = [];
  for (const path of changed)
    if ((onDisk.get(path) ?? null) !== (await git.blobAt(checkout, tip, path))) left.push(path);
  return left;
}

/** Whether the run's lane branch holds commits: its folder then holds work the base lacks. */
async function holdsLaneWork(db: DbReader, git: ClaimGit, row: WorkstreamRow): Promise<boolean> {
  const lane = laneBranchOf(row);
  return lane !== null && (await git.branchTip(checkoutOf(db, row), lane.lane)) !== null;
}

/**
 * A workstream parked on a question to a person lets go of its claims when its checkout holds nothing
 * uncommitted in any of them, so the people it waits for do not stall the tasks that need the same
 * areas; the scheduler asks for them again, like any queued task's, when the answer requeues it. With
 * any edit left uncommitted under any claim it keeps every claim: those edits stay the waiting task's,
 * and a partial release could leave it holding one claim while another task holds the other and waits
 * for it, which no check would see. A pass's page holds its pass's areas for the pass's life and never
 * lets go. Answers whether the claims were released.
 */
export async function yieldClaimsWhileWaiting(
  deps: { readonly state: StateStore; readonly git: ClaimGit },
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
  // A run with commits on its lane branch has unlanded work in the folder, under its claims.
  if (await holdsLaneWork(db, deps.git, before).catch(() => true)) return false;
  // A checkout git can't read is not known to be clean: nothing is released.
  const dirty = await claimedChanges(db, deps.git, before).catch(() => null);
  if (dirty === null || dirty.length > 0) return false;
  return deps.state.write((ctx) => {
    // The answer, a stop or a restart may have moved it while git was read.
    if (!waiting(getWorkstreamRow(ctx.tx, id))) return false;
    if (releaseClaims(ctx, id) === 0) return false;
    // A claim granted mid-session is gone: a repeat of its call asks again.
    forgetGrantedClaimOps(ctx, id);
    return true;
  });
}
