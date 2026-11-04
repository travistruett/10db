import {
  Delivery,
  landingText,
  taskLandingFor,
  TaskStatus,
  UNFINISHED_BATCH_STATES,
  type ProjectDto,
  type TaskDto,
  type TaskLanding,
} from '@10db/contracts';
import { listBatches, listProjects, listTasks, resetTaskLanding } from '@10db/db';
import type { Card } from './cards';
import { networkCall, raiseIn, type DeliveryContext } from './context';

/** A project's open tasks that land on a branch other than its base, by branch. */
function branchLandings(project: ProjectDto, tasks: readonly TaskDto[]): Map<string, TaskDto[]> {
  const byBranch = new Map<string, TaskDto[]>();
  for (const task of tasks) {
    if (task.status !== TaskStatus.Open || task.landing.kind !== 'branch') continue;
    if (task.landing.branch === project.baseBranch) continue;
    byBranch.set(task.landing.branch, [...(byBranch.get(task.landing.branch) ?? []), task]);
  }
  return byBranch;
}

/** The card that says which tasks moved; the builder only reads it. */
function movedCard(
  project: ProjectDto,
  moved: readonly { readonly task: TaskDto; readonly from: string }[],
  to: TaskLanding,
): Card {
  const lines = moved.map(
    ({ task, from }) =>
      `- ${task.title} (${task.id}): was ${from}, now ${landingText(to, project.baseBranch)}`,
  );
  const branches = [...new Set(moved.map((m) => m.from))].join(', ');
  return {
    title: `${String(moved.length)} task${moved.length === 1 ? '' : 's'} moved off ${branches}, which no longer exists`,
    body: `Origin has no branch named ${branches} and no open batch is based on it, so ${project.name} tasks that landed there could not be built or join a batch. They now land where the project's tasks land by default:\n${lines.join('\n')}`,
  };
}

/**
 * Moves every open task that lands on a branch that origin no longer has, and that no unfinished
 * batch is based on, to its project's default landing, and raises one card per project naming the
 * tasks that moved. A branch is moved only when origin answers that it is missing: an unreachable
 * origin, a project default that names the same missing branch, or one that names another branch
 * origin lacks, changes nothing. Running it again finds nothing to move. Returns the tasks moved.
 */
export async function moveRetiredLandings(
  ctx: DeliveryContext,
  signal: AbortSignal,
): Promise<TaskDto[]> {
  const movedAll: TaskDto[] = [];
  for (const project of listProjects(ctx.state.db)) {
    if (project.delivery !== Delivery.PullRequest) continue;
    const byBranch = branchLandings(project, listTasks(ctx.state.db, project.id));
    if (byBranch.size === 0) continue;
    const target = taskLandingFor(project);
    const answers = new Map<string, boolean | null>();
    const exists = async (branch: string): Promise<boolean | null> => {
      if (branch === project.baseBranch) return true;
      const known = answers.get(branch);
      if (known !== undefined) return known;
      let there: boolean | null;
      try {
        there = await ctx.git.branchOnOrigin(project.repoPath, branch, networkCall(ctx, signal));
      } catch (error) {
        ctx.logger.warn(
          { projectId: project.id, branch, err: error },
          'landing branch not checked',
        );
        there = null;
      }
      answers.set(branch, there);
      return there;
    };
    // Where the tasks would go has to exist, or they would only move from one dead branch to another.
    if (target.kind === 'branch' && (await exists(target.branch)) !== true) {
      ctx.logger.warn(
        { projectId: project.id, branch: target.branch },
        'default landing branch is not on origin; tasks on retired branches stay',
      );
      continue;
    }
    const inUse = new Set(
      listBatches(ctx.state.db, { projectId: project.id, states: UNFINISHED_BATCH_STATES }).map(
        (b) => b.baseBranch,
      ),
    );
    const moved: { task: TaskDto; from: string }[] = [];
    for (const [branch, tasks] of byBranch) {
      if (inUse.has(branch)) continue;
      if (target.kind === 'branch' && target.branch === branch) continue;
      if ((await exists(branch)) !== false) continue;
      for (const task of tasks) moved.push({ task, from: branch });
    }
    if (moved.length === 0) continue;
    const written = ctx.state.write((w) => {
      const done = moved.map(({ task }) => resetTaskLanding(w, task.id, target));
      raiseIn(w, project.id, movedCard(project, moved, target));
      return done;
    });
    ctx.logger.info(
      { projectId: project.id, tasks: moved.map((m) => m.task.id) },
      'tasks moved off a retired landing branch',
    );
    movedAll.push(...written);
  }
  return movedAll;
}
