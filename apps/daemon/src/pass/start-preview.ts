import {
  AreaRole,
  PassLackKind,
  type AreaDef,
  type PassLackDto,
  type PassStartDto,
  type PassStartPageDto,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  findOpenPass,
  findUnfinishedBatch,
  folderAreaHolder,
  getProject,
  getTask,
  getWorkstreamRow,
  type DbReader,
} from '@10db/db';
import { lanesInProjectCheckout, returnBranchProblem } from '../delivery';
import type { Git } from '../git';
import { classifyPath } from '../guard';

// Workbench spec §4.2: what Start Pass says before it starts. It reads the folder and the rows, and
// writes nothing; the open refuses again whatever changed since.

export interface PassStartDeps {
  readonly db: DbReader;
  readonly git: Git;
  /** Whether the project's gate is seen to call Docker, read from its committed base. */
  readonly gateCallsDocker: (project: ProjectDto) => Promise<boolean>;
}

/** Why a pass can't open now, as a code the picker keys on, beside the words it shows. */
const PassStartRefusal = {
  NoPageArea: 'no_page_area',
  PassOpen: 'pass_open',
  UnfinishedBatch: 'unfinished_batch',
  LanesInFolder: 'lanes_in_folder',
  OperationInProgress: 'operation_in_progress',
  DetachedHead: 'detached_head',
  ReturnBranch: 'return_branch',
} as const;

/** The first of what refuses the project a pass from its rows, in the order opening checks them. */
function rowRefusal(db: DbReader, project: ProjectDto): PassStartDto['refusal'] {
  if (!project.areas.some((a) => a.role === AreaRole.Page))
    return {
      code: PassStartRefusal.NoPageArea,
      message: `${project.name} has no page area; mark the areas that are pages in Settings › Areas and hazards first`,
    };
  const open = findOpenPass(db, project.id);
  if (open)
    return {
      code: PassStartRefusal.PassOpen,
      message: `Pass "${open.name}" is still ${open.state.toLowerCase()} in ${project.name}`,
    };
  const unfinished = findUnfinishedBatch(db, project.id);
  if (unfinished)
    return {
      code: PassStartRefusal.UnfinishedBatch,
      message: `Batch "${unfinished.title}" in Your folder is still ${unfinished.state.toLowerCase()}; a pass opens once it has finished`,
    };
  const lanes = lanesInProjectCheckout(db, project);
  if (lanes > 0)
    return {
      code: PassStartRefusal.LanesInFolder,
      message: `${String(lanes)} task${lanes === 1 ? ' is' : 's are'} running in Your folder; a pass opens once they stop`,
    };
  return null;
}

/**
 * What refuses the folder a pass, in the order opening meets it: an operation git left waiting, a
 * detached HEAD, then a branch the close could not return to (`returnBranchProblem`).
 */
async function folderRefusal(
  deps: PassStartDeps,
  project: ProjectDto,
  branch: string | null,
): Promise<PassStartDto['refusal']> {
  const busy = await deps.git.operationInProgress(project.repoPath);
  if (busy !== null)
    return {
      code: PassStartRefusal.OperationInProgress,
      message: `Your folder is in the middle of ${busy.what}; finish it or stop it (${busy.end}) before opening a pass`,
    };
  if (branch === null)
    return {
      code: PassStartRefusal.DetachedHead,
      message:
        "Your folder's HEAD is detached; switch it to a branch (git switch <your branch>) before opening a pass, so its close has a branch to return to",
    };
  const stray = returnBranchProblem(deps.db, project, branch);
  return stray === null ? null : { code: PassStartRefusal.ReturnBranch, message: stray };
}

/** The page area a changed path counts for: a file under a page is the page's (spec §7.3). */
function pageOf(path: string, project: ProjectDto, pages: readonly AreaDef[]): string | null {
  const hit = classifyPath(path, project.areas, project.hazards).areas;
  return pages.find((page) => hit.includes(page.name))?.name ?? null;
}

/** What the project lacks for a pass, each said above the button; none of them refuses it. */
async function lacksOf(
  deps: PassStartDeps,
  project: ProjectDto,
  branch: string | null,
): Promise<PassLackDto[]> {
  const lacks: PassLackDto[] = [];
  if (
    !project.sandboxDocker &&
    project.gateCommand !== null &&
    (await deps.gateCallsDocker(project))
  )
    lacks.push({ kind: PassLackKind.DockerOff, count: null, branch: null });
  const base = await deps.git.trackingTip(project.repoPath, project.baseBranch);
  if (base !== null) {
    const ahead = (await deps.git.commitsSince(project.repoPath, base, 'HEAD')).length;
    if (ahead > 0) lacks.push({ kind: PassLackKind.AheadOfBase, count: ahead, branch });
  }
  if (project.appUrl === null)
    lacks.push({ kind: PassLackKind.NoAppUrl, count: null, branch: null });
  if (project.changedCheckCommand === null)
    lacks.push({ kind: PassLackKind.NoChangedCheck, count: null, branch: null });
  return lacks;
}

/** The task holding the page in Your folder, by its title; null while none does. */
function holderOf(db: DbReader, project: ProjectDto, area: string): PassStartPageDto['heldBy'] {
  const holder = folderAreaHolder(db, project.id, area);
  if (holder === undefined) return null;
  const task = getTask(db, getWorkstreamRow(db, holder).taskId);
  return { taskId: task.id, title: task.title };
}

/**
 * The picker's page areas, each with its route, its last committed change, how many of its files are
 * changed in the folder and the task holding it; the folder's other changed files counted; what the
 * project lacks; and the first reason a pass can't open now, or null. Reads only.
 */
export async function passStartPreview(
  deps: PassStartDeps,
  projectId: ProjectId,
): Promise<PassStartDto> {
  const project = getProject(deps.db, projectId);
  const pages = project.areas.filter((a) => a.role === AreaRole.Page);
  const counts = new Map<string | null, number>();
  for (const path of await deps.git.changedPaths(project.repoPath)) {
    const page = pageOf(path, project, pages);
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  const listed: PassStartPageDto[] = [];
  for (const page of pages)
    listed.push({
      area: page.name,
      route: page.route ?? null,
      lastChangedAt: await deps.git.lastChangedAt(project.repoPath, page.globs),
      uncommitted: counts.get(page.name) ?? 0,
      heldBy: holderOf(deps.db, project, page.name),
    });
  const branch = await deps.git.currentBranch(project.repoPath);
  return {
    pages: listed,
    otherUncommitted: counts.get(null) ?? 0,
    lacks: await lacksOf(deps, project, branch),
    refusal: rowRefusal(deps.db, project) ?? (await folderRefusal(deps, project, branch)),
  };
}
