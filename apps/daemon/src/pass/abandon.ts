import {
  AbandonStep,
  PassState,
  TakeOutStep,
  type PassAbandonedDto,
  type PassDto,
  type PassId,
} from '@10db/contracts';
import {
  abandonPassAndBatch,
  findOpenByFoldKey,
  getAbandonStep,
  getBatch,
  getPass,
  getProject,
  getTask,
  leavePass,
  listPassTakeOuts,
  listPassTasks,
  setAbandonStep,
} from '@10db/db';
import { jobKey, JobQueue } from '../delivery';
import { flagCard, withdrawCard } from '../inbox';
import { PASS_CARD_DETAIL, PASS_CARD_KIND, PassCardKind } from './folder';
import { passBranch, type PassWorkDeps } from './kept-work';
import { takeOutSteps, TakeOutWithin, type TakeOutDeps } from './take-out';

// Workbench spec §5.4 (D23): Abandon Pass is the exit that always works. Each unsigned page's files go
// back to their state before the pass, its work kept with its task, and the pass and its batch end
// ABANDONED, step by recorded step (`passes.abandon_step`) so a restart goes on from the next.

/** The fold key of the card an Abandon leaves. */
export const passAbandonCardKey = (passId: PassId): string => `pass-abandon:${passId}`;

/** The option that moves the folder from an abandoned pass's branch to the branch it came from. */
export const moveToLabel = (branch: string): string => `Move to ${branch}`;

/** A file an Abandon left as it was, with the page it belongs to. */
interface LeftFile {
  readonly path: string;
  readonly page: string;
}

/** What the pass's take-outs put back and left, read from their rows. */
function takenOut(deps: TakeOutDeps, pass: PassDto) {
  const db = deps.state.db;
  const rows = listPassTakeOuts(db, pass.id).filter((row) => row.step === TakeOutStep.Done);
  return {
    reverted: rows.map((row) => row.taskId),
    left: rows.flatMap((row) =>
      row.left.map((path): LeftFile => ({ path, page: getTask(db, row.taskId).title })),
    ),
    rows,
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
 * Abandons the pass (spec §5.4) for a caller already holding the project's delivery key, going on
 * from the last step it recorded: 1 the pass is ABANDONING, so no message, sign-off or close is taken;
 * 2 a ship in flight is aborted, which slice 7's sign-off and close bring; 3 every session of the pass
 * is stopped, its last work kept; 4 each shared change not landed is dropped, which slice 6's shared
 * areas bring; 5 each page still in the pass is taken out by the take-out's own steps, inside the
 * Abandon, so files that keep changing are left and named rather than stopping it; 6 signed-off pages
 * stay as landed; 7 the pass and its batch are ABANDONED in one write; 8 where nothing landed, HEAD is
 * pointed back at the branch the pass came from, and the folder's own index is refreshed for the files
 * the take-outs wrote. A card says where the folder is when it stays, and names each file left.
 */
export async function abandonPassSteps(
  deps: TakeOutDeps,
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

  if (before(AbandonStep.Abandoning) || getPass(db, passId).state === PassState.Open)
    record(AbandonStep.Abandoning);
  // Step 2's place: a pass ships only once slice 7 lands sign-off and its close.
  if (before(AbandonStep.ShipAborted)) record(AbandonStep.ShipAborted);
  if (before(AbandonStep.SessionsStopped)) {
    for (const task of listPassTasks(db, passId))
      if (task.workstreamId !== null) await deps.stopLane(task.workstreamId);
    record(AbandonStep.SessionsStopped);
  }
  // Step 4's place: shared changes come with slice 6's shared areas.
  if (before(AbandonStep.SharedDropped)) record(AbandonStep.SharedDropped);
  if (before(AbandonStep.PagesTakenOut)) {
    for (const task of listPassTasks(db, passId)) {
      if (task.workstreamId === null)
        deps.state.write((ctx) => {
          leavePass(ctx, task.id);
        });
      else await takeOutSteps(deps, { taskId: task.id, within: TakeOutWithin.Abandon });
    }
    record(AbandonStep.PagesTakenOut);
  }
  // Step 6's place: signed-off pages stay as landed; sign-off comes with slice 7.
  if (before(AbandonStep.SignedOffKept)) record(AbandonStep.SignedOffKept);
  if (before(AbandonStep.Abandoned)) {
    deps.state.write((ctx) => {
      abandonPassAndBatch(ctx, passId);
    });
    step = AbandonStep.Abandoned;
  }

  const pass = getPass(db, passId);
  const { git } = deps;
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const done = takenOut(deps, pass);
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
    stays: [],
    left: done.left,
    folder: { branch: on ?? 'HEAD', returned: on === pass.returnBranch },
    droppedShared: [],
    pullRequestLeftOpen: pullRequest,
  };
}

/**
 * Abandons the pass as a job under the project's delivery key, as a pass opens and a page is taken
 * out, so it never interleaves with either. Refused once the pass is neither open nor abandoning.
 */
export function abandonPass(deps: TakeOutDeps, passId: PassId): Promise<PassAbandonedDto> {
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
