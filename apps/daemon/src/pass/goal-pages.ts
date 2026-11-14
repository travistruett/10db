import { AreaRole, type GoalId, type GoalPassPagesDto, type TaskId } from '@10db/contracts';
import {
  getGoal,
  getProject,
  listEvidence,
  listTasks,
  listWorkstreams,
  type DbReader,
} from '@10db/db';
import type { Git } from '../git';
import { classifyPath } from '../guard';

// Workbench spec §4.2: Work on This, in Factory, opens a pass on the pages a goal's tasks committed in.

export interface GoalPagesDeps {
  readonly db: DbReader;
  readonly git: Git;
}

/** The paths a commit changed against its first parent; none when git no longer has it. */
async function pathsOf(git: Git, repo: string, sha: string): Promise<string[]> {
  if (!(await git.hasCommit(repo, sha))) return [];
  try {
    return await git.filesChangedBetween(repo, `${sha}^`, sha);
  } catch {
    // A root commit has no parent to compare with; a goal's task never made one.
    return [];
  }
}

/**
 * The page areas the goal's tasks committed in, in the order of the project's areas, and the tasks
 * whose commits did, in the goal's order: each commit its lanes recorded is read from git, and each
 * path classified as the guard classifies it. A commit git no longer has names nothing. Reads only.
 */
export async function goalPassPages(
  deps: GoalPagesDeps,
  goalId: GoalId,
): Promise<GoalPassPagesDto> {
  const goal = getGoal(deps.db, goalId);
  const project = getProject(deps.db, goal.projectId);
  const pages = project.areas.filter((a) => a.role === AreaRole.Page).map((a) => a.name);
  const runs = listWorkstreams(deps.db, { projectId: project.id });
  const found = new Set<string>();
  const fromTasks: TaskId[] = [];
  for (const task of listTasks(deps.db, project.id).filter((t) => t.goalId === goalId)) {
    const shas = new Set(
      runs
        .filter((run) => run.taskId === task.id)
        .flatMap((run) => listEvidence(deps.db, run.id).flatMap((e) => e.commitShas)),
    );
    let named = false;
    for (const sha of shas)
      for (const path of await pathsOf(deps.git, project.repoPath, sha))
        for (const area of classifyPath(path, project.areas, project.hazards).areas)
          if (pages.includes(area)) {
            found.add(area);
            named = true;
          }
    if (named) fromTasks.push(task.id);
  }
  return { pages: pages.filter((p) => found.has(p)), fromTasks };
}
