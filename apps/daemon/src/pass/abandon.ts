import {
  AbandonStep,
  BatchState,
  PassState,
  TakeOutStep,
  WorkstreamState,
  type PassAbandonedDto,
  type PassDto,
  type PassId,
  type PassSharedChangeDto,
  type TaskDto,
} from '@10db/contracts';
import {
  abandonPassAndBatch,
  deleteSignOffWait,
  findOpenByFoldKey,
  getAbandonStep,
  getBatch,
  getPass,
  getProject,
  getTask,
  getWorkstreamRow,
  leavePass,
  listPassTakeOuts,
  listPassTasks,
  listSharedChanges,
  listSignOffWaits,
  openHolds,
  setAbandonStep,
  transitionBatch,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { jobKey, JobQueue } from '../delivery';
import { flagCard, withdrawCard } from '../inbox';
import { PASS_CARD_DETAIL, PASS_CARD_KIND, PassCardKind, withdrawFolderCard } from './folder';
import { passBranch, readKeptRef, type PassWorkDeps } from './kept-work';
import { keepOrLetGo } from './shared-chain';
import { dropShared } from './shared-drop';
import { sharedRef } from './shared-hold';
import { takeOutSteps, TakeOutWithin, type TakeOutDeps } from './take-out';

// Workbench spec §5.4 (D23): Abandon Pass is the exit that always works. Each unsigned page's files go
// back to their state before the pass, its work kept with its task, and the pass and its batch end
// ABANDONED, step by recorded step (`passes.abandon_step`) so a restart goes on from the next.

/**
 * What an Abandon needs: a take-out's, and the stop of what ships for the pass (its pull request's
 * checks and its close's job), which a restart has none of.
 */
export type AbandonDeps = TakeOutDeps & {
  readonly stopShip?: (passId: PassId) => Promise<void>;
};

/** Where the shared chain was when an Abandon began dropping: the drops after it are the Abandon's. */
const abandonMarkRef = (pass: PassId): string => `refs/10db/passes/${pass}/abandon-from`;

/** The fold key of the card an Abandon leaves. */
export const passAbandonCardKey = (passId: PassId): string => `pass-abandon:${passId}`;

/** The option that moves the folder from an abandoned pass's branch to the branch it came from. */
export const moveToLabel = (branch: string): string => `Move to ${branch}`;

/** A file an Abandon left as it was, with the page it belongs to. */
interface LeftFile {
  readonly path: string;
  readonly page: string;
}

/** Whether the page is signed off: its run is DONE, so an Abandon leaves it as landed. */
function signedOff(db: DbReader, task: TaskDto): boolean {
  return (
    task.workstreamId !== null &&
    getWorkstreamRow(db, task.workstreamId).state === WorkstreamState.Done
  );
}

/** What the pass's take-outs put back and left, read from their rows. */
function takenOut(db: DbReader, pass: PassDto) {
  const rows = listPassTakeOuts(db, pass.id).filter((row) => row.step === TakeOutStep.Done);
  return {
    reverted: rows.map((row) => row.taskId),
    left: rows.flatMap((row) =>
      row.left.map((path): LeftFile => ({ path, page: getTask(db, row.taskId).title })),
    ),
    rows,
  };
}

/** Each file the pass's take-outs left as it was, with its page, as the Abandon's card names them. */
export function abandonLeftFiles(db: DbReader, pass: PassDto): readonly LeftFile[] {
  return takenOut(db, pass).left;
}

/**
 * The shared changes this Abandon dropped: the drop rows whose commits the chain did not hold when
 * its step 4 began (`abandonMarkRef`), and each of their files not back on disk: one an Abandon's
 * drop left because it changed since it was checked. A file is compared with the last of those drops
 * that names it, since drops go newest first and the last puts it back furthest.
 */
async function droppedShared(deps: TakeOutDeps, pass: PassDto) {
  const db = deps.state.db;
  const repo = getProject(db, pass.projectId).repoPath;
  const before = await readKeptRef(deps.git, repo, abandonMarkRef(pass.id));
  const drops: PassSharedChangeDto[] = [];
  for (const change of listSharedChanges(db, pass.id))
    if (
      change.dropOf !== null &&
      (before === null || !(await deps.git.isAncestor(repo, change.sha, before)))
    )
      drops.push(change);
  const last = new Map<string, PassSharedChangeDto>();
  for (const drop of drops) for (const path of drop.paths) last.set(path, drop);
  const left: LeftFile[] = [];
  for (const file of await deps.git.hashOnDisk(repo, [...last.keys()])) {
    const drop = last.get(file.path);
    if (drop && file.blob !== (drop.blobs[file.path] ?? null))
      left.push({ path: file.path, page: `a shared change of ${getTask(db, drop.taskId).title}` });
  }
  return {
    drops: drops.map((d) => ({ seq: d.dropOf ?? d.seq, paths: [...d.paths] })),
    left,
  };
}

/**
 * Raises, or raises again, the one card an Abandon leaves: where the folder is, each file left as it
 * was with its page, and a pull request no longer watched. While the folder stays on the pass's
 * branch it offers the move back to the branch the pass came from.
 */
export function raiseAbandonCard(
  deps: PassWorkDeps,
  pass: PassDto,
  input: {
    readonly on: string | null;
    readonly left: readonly LeftFile[];
    readonly pullRequest: string | null;
    readonly why?: string;
  },
): void {
  const branch = passBranch(deps.state.db, pass);
  const stays = input.on === branch;
  const where = input.on ?? 'a detached HEAD';
  const parts = [
    stays
      ? `Your folder stays on ${branch}, which holds what the pass landed. Merge it into ${pass.returnBranch} with \`git merge ${branch}\`, or move to ${pass.returnBranch}, which takes the landed pages off the screen and keeps them on ${branch}.`
      : `Your folder is on ${where}.`,
  ];
  if (input.left.length > 0)
    parts.push(
      `Left as they are, because they kept changing:\n${input.left.map((f) => `- ${f.path} (${f.page})`).join('\n')}`,
    );
  if (input.pullRequest !== null)
    parts.push(
      `Its pull request stays open and is no longer watched: ${input.pullRequest}. Close it on GitHub if it is not wanted.`,
    );
  if (input.why !== undefined) parts.push(`10db could not move it: ${input.why}`);
  deps.state.write((ctx) =>
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `Workbench pass "${pass.name}" was abandoned`,
      body: parts.join('\n\n'),
      foldKey: passAbandonCardKey(pass.id),
      ...(input.why === undefined ? {} : { refresh: true }),
      detail: { [PASS_CARD_DETAIL]: pass.id, [PASS_CARD_KIND]: PassCardKind.Abandon },
      options: stays
        ? [
            {
              label: moveToLabel(pass.returnBranch),
              description: `Checks out ${pass.returnBranch} in Your folder, keeping uncommitted changes; refused while one lies where the switch writes`,
            },
          ]
        : [],
    }),
  );
}

/** Withdraws the card an Abandon left, if it is open. */
export function withdrawAbandonCard(deps: PassWorkDeps, pass: PassDto): void {
  deps.state.write((ctx) => {
    const card = findOpenByFoldKey(ctx.tx, pass.projectId, passAbandonCardKey(pass.id));
    if (card) withdrawCard(ctx, card.id);
  });
}

/**
 * Step 1 of an Abandon, in the caller's write: the pass is ABANDONING, and no sign-off is taken from
 * here on, so one waiting for a hold ends with it.
 */
function beginAbandon(ctx: WriteContext, passId: PassId): void {
  setAbandonStep(ctx, passId, AbandonStep.Abandoning);
  for (const wait of listSignOffWaits(ctx.tx, passId)) deleteSignOffWait(ctx, wait.taskId);
}

/**
 * Abandons the pass (spec §5.4) for a caller already holding the project's delivery key, going on
 * from the last step it recorded: 1 the pass is ABANDONING, so no message, sign-off or close is taken;
 * 2 a ship in flight is aborted (the pull request's checks, a close's job) and a shipping batch fails; 3 every session of the pass
 * is stopped, its last work kept; 4 each shared change not landed is dropped, newest first, its files
 * put back as its hold found them, with no refusal but the hash before each write; 5 each page still in the pass is taken out by the take-out's own steps, inside the
 * Abandon, so files that keep changing are left and named rather than stopping it; 6 signed-off pages
 * stay as landed; 7 the pass and its batch are ABANDONED in one write; 8 where nothing landed, HEAD is
 * pointed back at the branch the pass came from, and the folder's own index is refreshed for the files
 * the take-outs wrote. A card says where the folder is when it stays, and names each file left.
 */
export async function abandonPassSteps(
  deps: AbandonDeps,
  passId: PassId,
): Promise<PassAbandonedDto> {
  const db = deps.state.db;
  let step = getAbandonStep(db, passId);
  const record = (next: AbandonStep): void => {
    deps.state.write((ctx) => {
      setAbandonStep(ctx, passId, next);
    });
    step = next;
  };
  const before = (next: AbandonStep): boolean => step === null || step < next;

  if (before(AbandonStep.Abandoning) || getPass(db, passId).state === PassState.Open) {
    deps.state.write((ctx) => {
      beginAbandon(ctx, passId);
    });
    step = AbandonStep.Abandoning;
  }
  if (before(AbandonStep.ShipAborted)) {
    // A ship in flight is aborted: the pull request's checks and the close's job, each waited for
    // to the end of its step; a batch the close was shipping fails, the edge to ABANDONED after.
    await deps.stopShip?.(passId);
    deps.state.write((ctx) => {
      const batch = getBatch(ctx.tx, getPass(ctx.tx, passId).batchId);
      if (batch.state === BatchState.Shipping)
        transitionBatch(ctx, batch.id, { to: BatchState.Failed, reason: 'the pass is abandoned' });
    });
    record(AbandonStep.ShipAborted);
  }
  if (before(AbandonStep.SessionsStopped)) {
    for (const task of listPassTasks(db, passId))
      if (task.workstreamId !== null) await deps.stopLane(task.workstreamId);
    record(AbandonStep.SessionsStopped);
  }
  if (before(AbandonStep.SharedDropped)) {
    // A folder off the pass's branch holds another branch's files: the take-outs leave them as
    // they are, and so does this step, so an Abandon still finishes.
    const pass = getPass(db, passId);
    const repo = getProject(db, pass.projectId).repoPath;
    const onBranch = (await deps.git.currentBranch(repo)) === passBranch(db, pass);
    // Where the chain was before this Abandon dropped anything, so its report names its own drops.
    const mark = abandonMarkRef(passId);
    const tip = await readKeptRef(deps.git, repo, sharedRef(passId));
    if (tip !== null && (await readKeptRef(deps.git, repo, mark)) === null)
      await deps.git.keepRef(repo, mark, tip);
    // A hold a stopped turn left open is kept first, so what it changed is dropped too.
    for (const hold of onBranch ? openHolds(db, passId) : []) await keepOrLetGo(deps, hold.claimId);
    const unlanded = listSharedChanges(db, passId)
      .filter((c) => c.dropOf === null && c.droppedBy === null && c.landedSha === null)
      .filter((c) => c.paths.length > 0)
      .map((c) => c.seq)
      .sort((a, b) => b - a);
    for (const seq of onBranch ? unlanded : [])
      await dropShared(deps, { passId, seq, force: true });
    record(AbandonStep.SharedDropped);
  }
  if (before(AbandonStep.PagesTakenOut)) {
    for (const task of listPassTasks(db, passId)) {
      if (signedOff(db, task)) continue;
      if (task.workstreamId === null)
        deps.state.write((ctx) => {
          leavePass(ctx, task.id);
        });
      else await takeOutSteps(deps, { taskId: task.id, within: TakeOutWithin.Abandon });
    }
    record(AbandonStep.PagesTakenOut);
  }
  // Step 6: signed-off pages stay as landed, their commits on the pass's branch.
  if (before(AbandonStep.SignedOffKept)) record(AbandonStep.SignedOffKept);
  if (before(AbandonStep.Abandoned)) {
    deps.state.write((ctx) => {
      abandonPassAndBatch(ctx, passId);
    });
    step = AbandonStep.Abandoned;
  }

  const pass = getPass(db, passId);
  // An abandoned pass waits for no folder: its card about one is over.
  withdrawFolderCard(deps, pass);
  const { git } = deps;
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const taken = takenOut(db, pass);
  const dropped = await droppedShared(deps, pass);
  const done = { ...taken, left: [...dropped.left, ...taken.left] };
  const pullRequest = getBatch(db, pass.batchId).prUrl;
  if (before(AbandonStep.IndexRefreshed)) {
    // Nothing landed, so the branch it came from holds the same commit: naming it moves no file.
    if (
      (await git.currentBranch(repo)) === branch &&
      (await git.commitAt(repo, branch)) === pass.startSha
    )
      await git.pointHeadAt({ repo, from: branch, to: pass.returnBranch, sha: pass.startSha });
    const written = new Set<string>();
    for (const row of done.rows)
      if (row.keptSha !== null && row.keptBaseSha !== null)
        for (const path of await git.filesChangedBetween(repo, row.keptBaseSha, row.keptSha))
          if (!row.left.includes(path)) written.add(path);
    await git.refreshIndex(repo, [...written]);
    const on = await git.currentBranch(repo);
    if (on !== pass.returnBranch || done.left.length > 0 || pullRequest !== null)
      raiseAbandonCard(deps, pass, { on, left: done.left, pullRequest });
    record(AbandonStep.IndexRefreshed);
  }
  const on = await git.currentBranch(repo);
  return {
    reverted: done.reverted,
    stays: listPassTasks(db, passId)
      .filter((task) => signedOff(db, task))
      .map((task) => task.id),
    left: done.left,
    folder: { branch: on ?? 'HEAD', returned: on === pass.returnBranch },
    droppedShared: dropped.drops,
    pullRequestLeftOpen: pullRequest,
  };
}

/**
 * Abandon Pass from its route (spec §5.4, D23): step 1's write decides, here and now, outside the
 * delivery key, since a close running under that key stops only at its next conditional write; a
 * closing pass is refused once its close has moved the return branch. What ships for the pass is
 * stopped next, still outside the key, then the steps go on as a job.
 */
export async function startAbandon(deps: AbandonDeps, passId: PassId): Promise<PassAbandonedDto> {
  deps.state.write((ctx) => {
    if (getPass(ctx.tx, passId).state !== PassState.Abandoning) beginAbandon(ctx, passId);
  });
  // A close holds the delivery key the Abandon's job waits for: its abort is raised out here.
  await deps.stopShip?.(passId);
  return abandonPass(deps, passId);
}

/**
 * Abandons the pass as a job under the project's delivery key, as a pass opens and a page is taken
 * out, so it never interleaves with either. Refused once the pass is neither open nor abandoning.
 */
export function abandonPass(deps: AbandonDeps, passId: PassId): Promise<PassAbandonedDto> {
  const pass = getPass(deps.state.db, passId);
  return new Promise<PassAbandonedDto>((resolve, reject) => {
    deps.jobs.run(
      jobKey({ projectId: pass.projectId, worktreePath: null }, JobQueue.Cut),
      async () => {
        try {
          resolve(await abandonPassSteps(deps, passId));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}
