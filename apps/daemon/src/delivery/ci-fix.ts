import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mintId,
  type BatchDto,
  type RequiredCheckJobDto,
  type RequiredChecksDto,
  type StepPlanDto,
  type TaskId,
  type TaskLanding,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  getTask,
  insertBatch,
  insertTask,
  listBatches,
  listWorkstreams,
  patchBatch,
  type DbReader,
} from '@10db/db';
import { GhError, GhFailure } from '../github';
import { insertPlannedWorkstream, planForStart } from '../team';
import { ciFailureAction } from './ci-failure-action';
import {
  ciFixCriterion,
  ciFixDescription,
  ciFixLogName,
  ciFixTitle,
  logExcerpt,
  stripAnsi,
  type CiFixJob,
  type CiFixOther,
} from './ci-fix-text';
import { ghCall, type DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';
import { cutWorktree } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';

/** The failing jobs whose logs one fix task carries; any others are named without a log. */
const MAX_LOGGED_JOBS = 3;

/** The fix batches made for a root batch's pull request, in any state. */
function fixesOf(db: DbReader, root: BatchDto): BatchDto[] {
  return listBatches(db, { projectId: root.projectId }).filter((b) => b.ciFixOf === root.id);
}

/** A failing check named in the task without a log. */
const other = (job: RequiredCheckJobDto): CiFixOther => ({ name: job.name, link: job.link });

/**
 * Starts a fix for the root batch's pull request when `ciFailureAction` says so, with `head` the
 * commit its required checks failed on: reads the log of each failing Actions job, saves each in
 * full under the data directory, then in one write makes the task and its fix batch, and queues the
 * cut of that batch on the pull request's own branch. Resolves whether a fix was made.
 *
 * Nothing starts while any failing job's run is still in progress (its log is not ready), and a job
 * whose log GitHub no longer has is skipped. Any other failure of gh is thrown, for the watch to
 * treat as gh being down.
 */
export async function startCiFix(input: {
  readonly ctx: DeliveryContext;
  /** Where each job's full log is kept, under `logs/ci`. */
  readonly dataDir: string;
  readonly root: BatchDto;
  readonly required: RequiredChecksDto;
  readonly head: string | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { ctx, dataDir, required, head, signal } = input;
  const db = ctx.state.db;
  const root = getBatch(db, input.root.id);
  const { branch, prUrl, repo } = root;
  if (head === null || branch === null || prUrl === null || repo === null) return false;
  if (ciFailureAction(root, required, fixesOf(db, root), head).kind !== 'fix') return false;

  const actions = required.failing.filter((job) => job.jobId !== null);
  const logged = actions.slice(0, MAX_LOGGED_JOBS);
  const call = ghCall(ctx, signal);
  const dir = join(dataDir, 'logs', 'ci');
  const jobs: { readonly check: RequiredCheckJobDto; readonly shown: CiFixJob }[] = [];
  const unread: RequiredCheckJobDto[] = [];
  const logs: { readonly file: string; readonly text: string }[] = [];
  for (const check of logged) {
    if (check.jobId === null) continue;
    let log;
    try {
      log = await ctx.gh.jobLog({ repo, jobId: check.jobId }, call);
    } catch (error) {
      if (!(error instanceof GhError) || error.kind !== GhFailure.Failed) throw error;
      ctx.logger.warn(
        { batchId: root.id, job: check.name, err: error.message },
        'could not read a failing job log',
      );
      unread.push(check);
      continue;
    }
    // The run is still going: its log is not whole, so the next round reads again.
    if (log.kind === 'not_yet') return false;
    const file = join(dir, ciFixLogName(check.name, head));
    logs.push({ file, text: stripAnsi(log.log) });
    jobs.push({
      check,
      shown: { job: check.name, link: check.link, excerpt: logExcerpt(log.log), logFile: file },
    });
  }
  if (jobs.length === 0 || signal.aborted) return false;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const { file, text } of logs) writeFileSync(file, text, { mode: 0o600 });

  const fixed = new Set(jobs.map((job) => job.check));
  const others = [
    ...required.failing.filter((job) => !fixed.has(job) && !unread.includes(job)).map(other),
    ...unread.map(other),
  ];
  const description = ciFixDescription({
    pullRequest: prUrl,
    jobs: jobs.map((job) => job.shown),
    others,
  });
  const names = jobs.map((job) => job.check.name);
  const worktrees = madeWorktreeRoot(ctx.worktreeRoot);

  const made = ctx.state.write((w) => {
    // Decided again on the rows the write sees, so a repeat of this round makes nothing twice.
    const now = getBatch(w.tx, root.id);
    if (ciFailureAction(now, required, fixesOf(w.tx, now), head).kind !== 'fix') return null;
    const project = getProject(w.tx, now.projectId);
    const rootTasks = listWorkstreams(w.tx, { batchId: now.id }).map((ws) =>
      getTask(w.tx, ws.taskId),
    );
    const landing: TaskLanding | undefined = rootTasks[0]?.landing;
    const task = insertTask(w, project.id, {
      title: ciFixTitle(names.join(', '), now.title),
      description,
      acceptanceCriteria: names.map(ciFixCriterion),
      areas: [...new Set(rootTasks.flatMap((t) => t.areas))],
      workspaceMode: 'worktree',
      ...(landing === undefined ? {} : { landing }),
    });
    const id = mintId('Batch');
    const batch = insertBatch(w, {
      id,
      projectId: project.id,
      title: task.title,
      baseBranch: now.baseBranch,
      autoMerge: now.autoMerge,
      worktreePath: worktreePathFor(worktrees, project, `fix-${id}`),
      ciFix: { of: now.id, head },
    });
    patchBatch(w, id, { branch });
    const plans = new Map<TaskId, StepPlanDto>([[task.id, planForStart(w.tx, task.id)]]);
    for (const [taskId, plan] of plans) insertPlannedWorkstream(w, taskId, plan, id);
    return { batch, plans, project };
  });
  if (made === null) return false;

  ctx.jobs.run(jobKey(made.project, JobQueue.Cut), (jobSignal) =>
    cutWorktree(ctx, made.batch.id, made.plans, jobSignal),
  );
  ctx.logger.info(
    { batchId: made.batch.id, root: root.id, head, jobs: names },
    'started a fix for failing required checks',
  );
  return true;
}
