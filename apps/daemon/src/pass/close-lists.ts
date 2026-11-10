import { createHash } from 'node:crypto';
import {
  ConflictError,
  Delivery,
  PassClosePageChoice,
  PassPullRequestGate,
  SharedChoiceKind,
  WorkstreamState,
  type PassCloseGate,
  type PassClosePreviewDto,
  type PassCloseRequest,
  type PassDto,
  type PassId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  getPass,
  getProject,
  getWorkstreamRow,
  listPassTasks,
  listSharedChanges,
  openPassTurn,
  type DbReader,
} from '@10db/db';
import type { PassWorkDeps } from './kept-work';
import { sharedNeeded } from './shared-chain';
import { sharedUnlanded } from './shared-drop';
import { foreignCommits, unfinishedPages, unownedFiles } from './unowned';

// Workbench spec §5.4 (D25): what Close Pass… shows, built without stopping anything, and the check
// that a confirmed close is on the lists it was shown.

/** Where a close runs its gate: a scratch worktree before any take-out, the folder after, or none. */
export type CloseGateWhere = PassCloseGate['where'];

/** Where a close gates, from where the pass's pull request is gated (`passGateKind`). */
export function closeGateOf(kind: PassPullRequestGate): CloseGateWhere {
  switch (kind) {
    case PassPullRequestGate.Scratch:
      return 'scratch';
    case PassPullRequestGate.FolderAtClose:
      return 'folder';
    case PassPullRequestGate.None:
      return 'none';
  }
}

/** What the close lists read beside the pass's rows: where its project gates, and whether it has `origin`. */
export interface CloseListDeps extends Pick<PassWorkDeps, 'state' | 'git'> {
  readonly gateWhere: (pass: PassDto) => CloseGateWhere;
}

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** The line above the modal's footer: what lands where, and what follows. */
async function summaryOf(deps: CloseListDeps, pass: PassDto): Promise<string> {
  const db = deps.state.db;
  const project = getProject(db, pass.projectId);
  const signed = listPassTasks(db, pass.id).filter(
    (t) =>
      t.workstreamId !== null &&
      getWorkstreamRow(db, t.workstreamId).state === WorkstreamState.Done,
  ).length;
  const shared = listSharedChanges(db, pass.id).filter(
    (c) => c.dropOf === null && c.droppedBy === null && c.landedSha === null && c.paths.length > 0,
  ).length;
  const lands = `Lands ${plural(signed, 'page')} and ${plural(shared, 'shared change')} on \`${pass.returnBranch}\``;
  if ((await deps.git.remoteUrl(project.repoPath, 'origin')) === null)
    return `${lands}; with no origin, moving \`${pass.returnBranch}\` is the landing.`;
  return project.delivery === Delivery.Local
    ? `${lands}; opens a pull request as a record of the pass.`
    : `${lands}; opens a pull request for review.`;
}

function gateOf(where: CloseGateWhere): PassCloseGate {
  return {
    where,
    consequence:
      where === 'folder'
        ? 'The gate runs in Your folder after the pages set to Take Out are taken out: if it fails, the pass reopens with those pages already out, their work kept with their tasks.'
        : null,
  };
}

/** The token of the lists: everything a stopped turn could change, but not who was working. */
function tokenOf(lists: Omit<PassClosePreviewDto, 'token' | 'summary' | 'gate'>): string {
  const named = {
    unfinished: lists.unfinished.map((p) => ({ taskId: p.taskId, shared: p.sharedUnlanded })),
    unowned: lists.unowned,
    foreignCommits: lists.foreignCommits,
  };
  return createHash('sha256').update(JSON.stringify(named)).digest('hex').slice(0, 32);
}

/**
 * `GET /passes/:passId/close` (D25): the unfinished pages, whether each one's agent is working, and
 * the shared changes of each that have not landed; the files no unfinished page owns; the commits on
 * the branch 10db did not make; the summary line; where the gate runs; and the lists' token. It
 * stops nothing.
 */
export async function closePreview(
  deps: CloseListDeps,
  passId: PassId,
): Promise<PassClosePreviewDto> {
  const db = deps.state.db;
  const pass = getPass(db, passId);
  const unfinished = await Promise.all(
    unfinishedPages(db, passId).map(async (task) => ({
      taskId: task.id,
      title: task.title,
      working: openPassTurn(db, task.id) !== undefined,
      sharedUnlanded: await sharedUnlanded(deps, { passId, taskId: task.id }),
    })),
  );
  const lists = {
    unfinished,
    unowned: [...(await unownedFiles(deps, pass))],
    foreignCommits: [...(await foreignCommits(deps, pass))],
  };
  return {
    token: tokenOf(lists),
    ...lists,
    summary: await summaryOf(deps, pass),
    gate: gateOf(deps.gateWhere(pass)),
  };
}

/**
 * What differs between the lists a close was confirmed on and the lists now, one line each, so the
 * modal can mark them: a page that joined or left the unfinished pages, a file that joined or left
 * the files no page owns, a shared change that is new, and commits typed by hand since.
 */
export function closeChanges(request: PassCloseRequest, now: PassClosePreviewDto): string[] {
  const lines: string[] = [];
  const asked = new Set(request.pages.map((p) => p.taskId));
  for (const page of now.unfinished)
    if (!asked.has(page.taskId)) lines.push(`${page.title} is not signed off`);
  const pages = new Set(now.unfinished.map((p) => p.taskId));
  for (const page of request.pages)
    if (!pages.has(page.taskId)) lines.push(`A page set to ${page.choice} is no longer unfinished`);
  const files = new Set(request.files.map((f) => f.path));
  for (const file of now.unowned)
    if (!files.has(file.path)) lines.push(`${file.path} changed, and no page owns it`);
  const unowned = new Set(now.unowned.map((f) => f.path));
  for (const file of request.files)
    if (!unowned.has(file.path)) lines.push(`${file.path} is no longer a file no page owns`);
  const chosen = new Set(request.shared.map((c) => c.seq));
  for (const page of now.unfinished)
    for (const change of page.sharedUnlanded)
      if (!chosen.has(change.seq))
        lines.push(`${page.title} has shared change ${String(change.seq)}`);
  if (now.foreignCommits.length > 0)
    lines.push(`The branch holds ${plural(now.foreignCommits.length, 'commit')} 10db did not make`);
  return lines.length > 0 ? lines : ['The lists changed since they were shown'];
}

/** What a confirmed close is checked against beside its lists, read from the pass's rows. */
export interface ClosePages {
  /** The pages signed off already. */
  readonly signedOff: ReadonlySet<TaskId>;
  /** The highest number of the shared chain each unfinished page needs to sign off (`sharedNeeded`). */
  readonly needsUpTo: ReadonlyMap<TaskId, number>;
}

/** The pass's pages as `checkCloseRequest` reads them. */
export function closePages(db: DbReader, passId: PassId): ClosePages {
  const tasks = listPassTasks(db, passId);
  const done = (task: TaskDto): boolean =>
    task.workstreamId !== null &&
    getWorkstreamRow(db, task.workstreamId).state === WorkstreamState.Done;
  return {
    signedOff: new Set(tasks.filter(done).map((t) => t.id)),
    needsUpTo: new Map(
      tasks.filter((t) => !done(t)).map((t) => [t.id, sharedNeeded(db, passId, t.id).upTo]),
    ),
  };
}

/**
 * Refuses a confirmed close whose choices the lists do not allow (409): a page that is not one of
 * the unfinished pages, a file placed that is not one no page owns or in a task that is neither
 * signed off nor set to Sign Off Now, a Drop of a shared change that is not of a page set to Take
 * Out, or whose Drop is refused, and a Drop of a change a page set to Sign Off Now needs, since that
 * page's sign-off lands it.
 */
export function checkCloseRequest(
  preview: PassClosePreviewDto,
  request: PassCloseRequest,
  closing: ClosePages,
): void {
  const pages = new Map(preview.unfinished.map((p) => [p.taskId, p]));
  for (const page of request.pages)
    if (!pages.has(page.taskId))
      throw new ConflictError(`Task ${page.taskId} is not an unfinished page of the pass`);
  const signing = new Set([
    ...closing.signedOff,
    ...request.pages.filter((p) => p.choice === PassClosePageChoice.SignOff).map((p) => p.taskId),
  ]);
  const unowned = new Set(preview.unowned.map((f) => f.path));
  for (const file of request.files)
    if (file.placeIn !== null && !unowned.has(file.path))
      throw new ConflictError(`${file.path} is not a file no page owns: only those are placed`);
  for (const file of request.files)
    if (file.placeIn !== null && !signing.has(file.placeIn))
      throw new ConflictError(
        `${file.path} can be added only to a page that is signed off or set to Sign Off Now`,
      );
  const takingOut = new Set(
    preview.unfinished
      .filter(
        (p) =>
          request.pages.find((c) => c.taskId === p.taskId)?.choice !== PassClosePageChoice.SignOff,
      )
      .map((p) => p.taskId),
  );
  const offered = new Map(
    preview.unfinished
      .filter((p) => takingOut.has(p.taskId))
      .flatMap((p) => p.sharedUnlanded.map((c) => [c.seq, c.dropRefusal] as const)),
  );
  for (const choice of request.shared) {
    if (choice.choice !== SharedChoiceKind.Drop) continue;
    if (!offered.has(choice.seq))
      throw new ConflictError(
        `Shared change ${String(choice.seq)} is not one of a page set to Take Out that has not landed`,
      );
    const refused = offered.get(choice.seq);
    if (refused)
      throw new ConflictError(`Shared change ${String(choice.seq)} cannot be dropped: ${refused}`);
    const needing = request.pages.find(
      (p) =>
        p.choice === PassClosePageChoice.SignOff &&
        choice.seq <= (closing.needsUpTo.get(p.taskId) ?? 0),
    );
    if (needing)
      throw new ConflictError(
        `Shared change ${String(choice.seq)} cannot be dropped: ${pages.get(needing.taskId)?.title ?? needing.taskId} is set to Sign Off Now and was built with it`,
      );
  }
}
