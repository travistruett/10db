import {
  ACTIVE_STATES,
  AreaRole,
  BRANCH_PREFIX,
  ClaimKind,
  ConflictError,
  InvalidError,
  mintId,
  PASS_PAGE_CAP_DEFAULT,
  PASS_PAGE_CAP_MAX,
  PassPageCap,
  passHeldAreas,
  passPagesProblem,
  PassState,
  slugOf,
  StepRole,
  TaskStatus,
  type BatchDto,
  type BatchId,
  type GoalId,
  type Notice,
  type PassDirtEntry,
  type PassDto,
  type PassId,
  type ProjectDto,
  type ProjectId,
  type StepPlanDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  acquireClaims,
  copyHazardNames,
  findOpenPass,
  findUnfinishedBatch,
  getGoal,
  getProject,
  getTask,
  getTaskKeptWork,
  getPass,
  getWorkstreamRow,
  insertPass,
  insertPassPageTask,
  listBatches,
  listPassDirt,
  passHoldingTask,
  setWorkstreamNotice,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { githubRepoOf } from '../github';
import { insertPlannedWorkstream, resolveStepPlan } from '../team';
import { lanesInProjectCheckout } from './checkout';
import type { DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import { stackOn, stackTarget } from './pass-stack';

// Workbench spec §5.1: opening a pass. No route reaches this yet; the route that opens a pass ships
// with the pass's turns, so no pass can be opened whose tasks could not run.

export interface PassOpenInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly taskIds: readonly TaskId[];
  /** How many pages it holds, 4 when absent, 6 at most (W11). */
  readonly pageCap?: number;
  /** Page areas each made a task "<Page>: UI work" in the open's own write. */
  readonly pages?: readonly string[];
  /** The goal those new tasks join; null or absent for none. */
  readonly goalId?: GoalId | null;
}

/** What a put-back of a task's saved work did: the files it wrote, and those it left and named. */
export interface PutBackResult {
  readonly applied: readonly string[];
  readonly left: readonly string[];
}

/** Puts a task's saved work back into the folder (spec §5.4); it never imports this module. */
export type PutBackKeptWork = (input: {
  readonly repo: string;
  readonly taskId: TaskId;
}) => Promise<PutBackResult>;

export interface PassOpenDeps {
  /** How long the page claims are leased before the scheduler renews them. */
  readonly leaseMs: number;
  /** Called for each task with saved work, once the pass is open, inside its job. */
  readonly putBack: PutBackKeptWork;
}

/** A task whose page another task held when the pass opened: it waits for it. */
export interface PassPageWait {
  readonly taskId: TaskId;
  readonly area: string;
  readonly heldBy: TaskId;
}

export interface PassOpened {
  readonly pass: PassDto;
  readonly batch: BatchDto;
  /** The folder's dirt when it opened, which stays as it was. */
  readonly dirt: readonly PassDirtEntry[];
  /**
   * The commits the folder's HEAD had that the project's base lacks, as origin's base was last
   * fetched; null when there is no such base to compare with. The pass opens either way, and its pull
   * request carries them until the branch they are on is pushed.
   */
  readonly aheadOfBase: number | null;
  readonly waiting: readonly PassPageWait[];
}

/** Where the commit holding a pass's dirt is kept. */
export const passDirtRef = (id: PassId): string => `refs/10db/passes/${id}/dirt`;

/** `10db/<slug>-<6 hex>`: the pass's name and the last six hex digits of its id. */
export function passBranchName(name: string, id: PassId): string {
  return `10db/${slugOf(name, 'pass')}-${id.slice(-6)}`;
}

/** What a task that waits for a page shows: the area and the task that holds it. */
function pageWaitNotice(area: string, holder: TaskDto): Notice {
  return {
    key: `claim-wait:${ClaimKind.Area}:${area}`,
    tone: 'info',
    line: `Waiting for area ${area}: task "${holder.title}" holds it`,
    body: `This page is claimed by "${holder.title}". It joins the pass as soon as that task lets it go.`,
  };
}

/**
 * What a task in a pass runs: the project's implement step alone (D21). A pass is reviewed once, at
 * its pull request, so no plan, review or QA step runs per turn.
 */
export function passPlan(db: DbReader, task: TaskDto): StepPlanDto {
  const plan = resolveStepPlan(db, task.id);
  const at = plan.steps.findIndex((step) => step.role === StepRole.Implement);
  const step = plan.steps[at];
  if (step === undefined)
    throw new InvalidError(`The steps of "${task.title}" have no implement step`);
  if (plan.overBudget.includes(at))
    throw new InvalidError(
      `The implement step of "${task.title}" (need ${String(step.need)} intelligence) has no profile within the budget ceiling: ${step.reason}. Raise the ceiling or lower the need in Settings › Models.`,
    );
  return { rigor: plan.rigor, steps: [step], overBudget: [] };
}

/** Throws what refuses these tasks a pass in the project, read from the database; writes nothing. */
function refuseOpen(
  db: DbReader,
  project: ProjectDto,
  tasks: readonly TaskDto[],
  pageCap: number,
  newPages: readonly NewPageTask[],
) {
  if (!project.areas.some((a) => a.role === AreaRole.Page))
    throw new ConflictError(
      `${project.name} has no page area; mark the areas that are pages in Settings › Areas and hazards first`,
    );
  const count = tasks.length + newPages.length;
  if (count === 0) throw new InvalidError('A pass needs at least one task');
  if (count > pageCap)
    throw new InvalidError(
      `A pass holds ${String(pageCap)} pages; ${String(count)} tasks and pages were named`,
    );
  for (const task of tasks) refusePassTask(db, project, task);
  const pages = passPagesProblem(project.areas, [...tasks, ...newPages]);
  if (pages !== null) throw new InvalidError(pages);
  const open = findOpenPass(db, project.id);
  if (open)
    throw new ConflictError(
      `Pass "${open.name}" is still ${open.state.toLowerCase()} in ${project.name}`,
    );
  const unfinished = findUnfinishedBatch(db, project.id);
  if (unfinished)
    throw new ConflictError(
      `Batch "${unfinished.title}" in Your folder is still ${unfinished.state.toLowerCase()}; a pass opens once it has finished`,
    );
  const lanes = lanesInProjectCheckout(db, project);
  if (lanes > 0)
    throw new ConflictError(
      `${String(lanes)} task${lanes === 1 ? ' is' : 's are'} running in Your folder; a pass opens once they stop`,
    );
}

/**
 * Why the branch HEAD names can't be the pass's return branch, in words, or null. A close
 * fast-forwards that branch to the pass's tip, so it must be the builder's own: not a batch's branch
 * left checked out (a crash before the switch back, a switch back a dirty folder held off, or a ship
 * not yet switched back), nor a branch under 10db's prefix no task names. The one exception is an
 * abandoned pass's branch, which holds the work it landed: a pass opened there returns to it.
 */
export function returnBranchProblem(
  db: DbReader,
  project: ProjectDto,
  branch: string,
): string | null {
  const batch = listBatches(db, { projectId: project.id }).find((b) => b.branch === branch);
  if (batch?.passId != null && getPass(db, batch.passId).state === PassState.Abandoned) return null;
  if (batch)
    return `Your folder is on ${branch}, the branch of ${batch.passId == null ? 'batch' : 'UI Workbench pass'} "${batch.title}"; switch it back to your own branch (git switch <your branch>) before opening a pass`;
  if (branch.startsWith(BRANCH_PREFIX))
    return `Your folder is on ${branch}, a 10db branch no task names; switch it to your own branch (git switch <your branch>) before opening a pass`;
  return null;
}

/**
 * Opens a pass on Your folder, in the project's delivery queue and under the checkout's repo lock:
 * the pass's branch at HEAD with no file written, the folder's dirt recorded with its content, the
 * pass and its batch on any delivery, each task's run on the implement step alone, and each task's
 * pages claimed through `acquireClaims`, as the scheduler claims them. A page another task holds makes
 * that task wait with the holder named. What the database already refuses is refused before anything
 * is queued; a start that slips in while git works, or a HEAD on a branch that can't be returned to,
 * is refused by the write, and the branch is taken back. Every refusal rejects; once the pass is
 * written it resolves, after each task's saved work has been put back, still in the job.
 */
export async function openPass(
  ctx: DeliveryContext,
  input: PassOpenInput,
  deps: PassOpenDeps,
): Promise<PassOpened> {
  const db = ctx.state.db;
  const project = getProject(db, input.projectId);
  const cap = PassPageCap.safeParse(input.pageCap ?? PASS_PAGE_CAP_DEFAULT);
  if (!cap.success)
    throw new InvalidError(`A pass holds from 1 to ${String(PASS_PAGE_CAP_MAX)} pages`);
  const pageCap = cap.data;
  const tasks = input.taskIds.map((id) => getTask(db, id));
  const newPages = newPageTasks(db, project, input.pages ?? [], input.goalId ?? null);
  refuseOpen(db, project, tasks, pageCap, newPages);
  const id = mintId('Pass');
  const branch = passBranchName(input.name, id);
  const dirtRef = passDirtRef(id);
  return new Promise<PassOpened>((resolve, reject) => {
    ctx.jobs.run(jobKey({ projectId: project.id, worktreePath: null }, JobQueue.Cut), async () => {
      let opened: PassOpened;
      try {
        opened = await ctx.git.operation(() => open());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const task of tasks) if (getTaskKeptWork(db, task.id) !== null) await putBack(task.id);
      resolve(opened);
    });
  });

  async function open(): Promise<PassOpened> {
    // As a cut reads it: origin's pinned push URL, never gh reading the checkout's remotes.
    const origin = await ctx.git.remoteUrl(project.repoPath, 'origin');
    const repo =
      origin === null ? null : githubRepoOf(await ctx.git.pinnedPushUrl(project.repoPath));
    const start = await ctx.git.openPassBranch({
      repo: project.repoPath,
      branch,
      dirtRef,
      message: `10db: the folder's dirt when pass ${id} opened`,
    });
    // A read git cannot answer stacks the pass on nothing, rather than leave its branch unwritten.
    const below = await stackTarget(ctx, project.id, start.startSha).catch(() => null);
    let written: { pass: PassDto; batch: BatchDto; waiting: PassPageWait[] };
    try {
      written = ctx.state.write((w) => {
        const stray = returnBranchProblem(w.tx, project, start.returnBranch);
        if (stray !== null) throw new ConflictError(stray);
        const pageTasks = [...tasks, ...writePageTasks(w, project, newPages)];
        const made = insertPass(w, {
          id,
          projectId: project.id,
          name: input.name,
          pageCap,
          returnBranch: start.returnBranch,
          startSha: start.startSha,
          branch,
          baseBranch: project.baseBranch,
          repo,
          taskIds: pageTasks.map((t) => t.id),
          dirt: start.dirt,
        });
        stackOn(w, id, below);
        const leaseExpiresAt = new Date(ctx.clock.now().getTime() + deps.leaseMs).toISOString();
        const waiting = startPassTasks(w, project, made.batch.id, pageTasks, leaseExpiresAt);
        return { ...made, waiting };
      });
    } catch (error) {
      const undone = await ctx.git
        .undoPassBranch({
          repo: project.repoPath,
          branch,
          returnBranch: start.returnBranch,
          startSha: start.startSha,
          dirtRef,
        })
        .catch(() => false);
      ctx.logger.warn(
        {
          projectId: project.id,
          branch,
          undone,
          err: error instanceof Error ? error.message : String(error),
        },
        'pass not opened',
      );
      throw error;
    }
    const aheadOfBase = await countAhead(start.startSha);
    ctx.logger.info(
      { projectId: project.id, passId: id, branch, startSha: start.startSha, aheadOfBase },
      'pass opened',
    );
    return {
      pass: written.pass,
      batch: written.batch,
      dirt: listPassDirt(db, id),
      aheadOfBase,
      waiting: written.waiting,
    };
  }

  /** Puts the task's saved work back; the pass is open either way, so a failure is logged, not thrown. */
  async function putBack(taskId: TaskId): Promise<void> {
    try {
      const done = await deps.putBack({ repo: project.repoPath, taskId });
      ctx.logger.info(
        { projectId: project.id, passId: id, taskId, applied: done.applied, left: done.left },
        'saved work put back',
      );
    } catch (error) {
      ctx.logger.warn(
        {
          projectId: project.id,
          passId: id,
          taskId,
          err: error instanceof Error ? error.message : String(error),
        },
        'saved work not put back',
      );
    }
  }

  /** The commits `startSha` has that origin's base lacks; null with none to compare, or when git can't say. */
  async function countAhead(startSha: string): Promise<number | null> {
    try {
      const base = await ctx.git.trackingTip(project.repoPath, project.baseBranch);
      if (base === null) return null;
      return (await ctx.git.commitsSince(project.repoPath, base, startSha)).length;
    } catch (error) {
      // The pass is written: a count that fails says nothing, and the pass stays open.
      ctx.logger.warn(
        {
          projectId: project.id,
          passId: id,
          err: error instanceof Error ? error.message : String(error),
        },
        'commits ahead of the base not counted',
      );
      return null;
    }
  }
}

/** A page the open makes a task for: its title and its one page area, and the goal it joins. */
export interface NewPageTask {
  readonly title: string;
  readonly areas: readonly [string];
  readonly goalId: GoalId | null;
}

/** "Settings: UI work": the title of the task a pass makes for a page (spec §4.2). */
function pageTaskTitle(area: string): string {
  return `${area.charAt(0).toUpperCase()}${area.slice(1)}: UI work`;
}

/**
 * The tasks a pass makes for `pages`, read and refused before anything is queued: each must be a page
 * area of the project, and the goal, when named, one of the project's.
 */
export function newPageTasks(
  db: DbReader,
  project: ProjectDto,
  pages: readonly string[],
  goalId: GoalId | null,
): NewPageTask[] {
  if (goalId !== null && getGoal(db, goalId).projectId !== project.id)
    throw new InvalidError(`The goal belongs to another project than ${project.name}`);
  return pages.map((page) => {
    if (!project.areas.some((a) => a.name === page && a.role === AreaRole.Page))
      throw new InvalidError(`${page} is not a page area of ${project.name}`);
    return { title: pageTaskTitle(page), areas: [page], goalId };
  });
}

/** Writes the new pages' tasks in the caller's write, so a refusal after it leaves none of them. */
export function writePageTasks(
  w: WriteContext,
  project: ProjectDto,
  pages: readonly NewPageTask[],
): TaskDto[] {
  return pages.map((page) =>
    insertPassPageTask(w, project.id, {
      title: page.title,
      area: page.areas[0],
      goalId: page.goalId,
    }),
  );
}

/** Throws what refuses an open task a place in a pass of the project, read from the database. */
export function refusePassTask(db: DbReader, project: ProjectDto, task: TaskDto): void {
  if (task.projectId !== project.id)
    throw new InvalidError(`Task ${task.title} belongs to another project`);
  if (task.status !== TaskStatus.Open)
    throw new ConflictError(`Task ${task.title} is ${task.status}`);
  if (task.boardColumnId !== null)
    throw new ConflictError(`Task ${task.title} is parked; move it to Backlog or Ready first`);
  const holding = passHoldingTask(db, task);
  if (holding) throw new ConflictError(`Task ${task.title} is already in pass "${holding.name}"`);
  const latest = task.workstreamId ? getWorkstreamRow(db, task.workstreamId) : null;
  if (latest && ACTIVE_STATES.includes(latest.state))
    throw new ConflictError(`Task ${task.title} is running; it can join a pass once it stops`);
}

/**
 * Gives each task of the pass its run in the pass's batch, on the implement step alone, and claims its
 * pages through `acquireClaims`, as the scheduler claims them, in the caller's write. A page another
 * task holds makes that task wait with the holder named; the waits are returned.
 */
export function startPassTasks(
  w: WriteContext,
  project: ProjectDto,
  batchId: BatchId,
  tasks: readonly TaskDto[],
  leaseExpiresAt: string,
): PassPageWait[] {
  const waiting: PassPageWait[] = [];
  for (const task of tasks) {
    const ws = insertPlannedWorkstream(w, task.id, passPlan(w.tx, task), batchId);
    const claimed = acquireClaims(w, {
      projectId: project.id,
      workstreamId: ws.id,
      requests: passHeldAreas(project.areas, task).map((name) => ({
        kind: ClaimKind.Area,
        name,
      })),
      copyHazards: copyHazardNames(project),
      leaseExpiresAt,
    });
    if (claimed.ok) continue;
    const holder = getTask(w.tx, getWorkstreamRow(w.tx, claimed.conflict.heldBy).taskId);
    waiting.push({ taskId: task.id, area: claimed.conflict.name, heldBy: holder.id });
    setWorkstreamNotice(w, ws.id, pageWaitNotice(claimed.conflict.name, holder));
  }
  return waiting;
}
