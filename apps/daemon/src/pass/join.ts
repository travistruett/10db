import {
  ConflictError,
  InvalidError,
  passPagesProblem,
  PassState,
  type PassDto,
  type PassId,
  type PassJoinRequest,
  type ProjectDto,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import {
  getBatch,
  getPass,
  getProject,
  getTask,
  getTaskKeptWork,
  insertBuilderMessage,
  joinPass as joinPassRows,
  listPassTasks,
  type DbReader,
} from '@10db/db';
import {
  jobKey,
  JobQueue,
  newPageTasks,
  refusePassTask,
  startPassTasks,
  writePageTasks,
  type DeliveryContext,
  type NewPageTask,
  type PassOpenDeps,
  type PassPageWait,
} from '../delivery';

// Workbench spec §4.3: Add Page. Pages and open tasks join an open pass as its opening took its first
// ones, in the project's delivery queue.

/** What Add Page did: the tasks now in the pass, in the order named, and those that wait for a page. */
export interface PassJoined {
  readonly joined: readonly TaskId[];
  readonly waiting: readonly PassPageWait[];
}

/** Throws what refuses these tasks and pages a place in the pass, read from the database. */
function refuseJoin(
  db: DbReader,
  pass: PassDto,
  project: ProjectDto,
  tasks: readonly TaskDto[],
  newPages: readonly NewPageTask[],
): void {
  if (pass.state !== PassState.Open)
    throw new ConflictError(
      `Pass "${pass.name}" is ${pass.state.toLowerCase()}: a page joins only an open pass`,
    );
  const held = listPassTasks(db, pass.id);
  const count = held.length + tasks.length + newPages.length;
  if (count > pass.pageCap)
    throw new ConflictError(
      `Pass "${pass.name}" holds ${String(pass.pageCap)} pages and has ${String(held.length)}; ${String(tasks.length + newPages.length)} more were named`,
    );
  for (const task of tasks) refusePassTask(db, project, task);
  const pages = passPagesProblem(project.areas, [...held, ...tasks, ...newPages]);
  if (pages !== null) throw new InvalidError(pages);
}

/**
 * Adds a task with no brief for each of `pages`, and the open tasks named, to the open pass: in one
 * write, each joins the pass, gets its run in the pass's batch on the implement step alone, and claims
 * its pages, a page another task holds making it wait with the holder named. Then, still in the job,
 * each task with saved work has it put back, and only after that, when the builder wrote one, each is
 * sent `firstMessage`, so no page starts on a folder half put back. Refused while Your folder is off
 * the pass's branch. A refusal rejects and joins nothing.
 */
export async function joinPass(
  ctx: DeliveryContext,
  passId: PassId,
  input: PassJoinRequest,
  deps: PassOpenDeps,
): Promise<PassJoined> {
  const db = ctx.state.db;
  const pass = getPass(db, passId);
  const project = getProject(db, pass.projectId);
  const tasks = input.taskIds.map((id) => getTask(db, id));
  const newPages = newPageTasks(db, project, input.pages, null);
  refuseJoin(db, pass, project, tasks, newPages);
  return new Promise<PassJoined>((resolve, reject) => {
    ctx.jobs.run(jobKey({ projectId: project.id, worktreePath: null }, JobQueue.Cut), async () => {
      let joined: PassJoined;
      try {
        await refuseOffBranch();
        joined = ctx.state.write((w) => {
          refuseJoin(w.tx, getPass(w.tx, passId), project, tasks, newPages);
          const ids = [...tasks, ...writePageTasks(w, project, newPages)].map((t) => t.id);
          joinPassRows(w, passId, ids);
          const leaseExpiresAt = new Date(ctx.clock.now().getTime() + deps.leaseMs).toISOString();
          const all = ids.map((id) => getTask(w.tx, id));
          const waiting = startPassTasks(w, project, pass.batchId, all, leaseExpiresAt);
          return { joined: ids, waiting };
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const task of tasks) if (getTaskKeptWork(db, task.id) !== null) await putBack(task.id);
      try {
        sendFirstMessage(joined);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ctx.logger.info({ projectId: project.id, passId, joined: joined.joined }, 'pages joined');
      resolve(joined);
    });
  });

  /**
   * Writes the builder's first message to every page that joined, once the saved work is back: a
   * message is what lets a page's lane start. The pages are in the pass already, so a write that fails
   * is refused in words that say so, and the builder sends the message from each page.
   */
  function sendFirstMessage(joined: PassJoined): void {
    const { firstMessage } = input;
    if (firstMessage === null) return;
    try {
      ctx.state.write((w) => {
        for (const id of joined.joined)
          insertBuilderMessage(w, id, { body: firstMessage, files: [] });
      });
    } catch (error) {
      const titles = joined.joined.map((id) => getTask(db, id).title).join(', ');
      ctx.logger.warn(
        {
          projectId: project.id,
          passId,
          err: error instanceof Error ? error.message : String(error),
        },
        'first message of joined pages not written',
      );
      throw new ConflictError(
        `${titles} joined pass "${pass.name}", but the first message was not sent (${error instanceof Error ? error.message : String(error)}); send it from each page`,
      );
    }
  }

  /**
   * Refuses the join while Your folder is off the pass's branch, as the folder card says it is: a
   * put-back there would write a page's saved work into another branch's files.
   */
  async function refuseOffBranch(): Promise<void> {
    const branch = getBatch(db, pass.batchId).branch;
    const head = await ctx.git.currentBranch(project.repoPath);
    if (branch === null || head === branch) return;
    throw new ConflictError(
      `Your folder is on ${head ?? 'a detached HEAD'}, not the branch of pass "${pass.name}" (${branch}); switch it back (git switch ${branch}) to add a page`,
    );
  }

  /** Puts the task's saved work back; it is in the pass either way, so a failure is logged, not thrown. */
  async function putBack(taskId: TaskId): Promise<void> {
    try {
      const done = await deps.putBack({ repo: project.repoPath, taskId });
      ctx.logger.info(
        { projectId: project.id, passId, taskId, applied: done.applied, left: done.left },
        'saved work put back',
      );
    } catch (error) {
      ctx.logger.warn(
        {
          projectId: project.id,
          passId,
          taskId,
          err: error instanceof Error ? error.message : String(error),
        },
        'saved work not put back',
      );
    }
  }
}
