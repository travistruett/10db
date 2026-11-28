import { GoalDto, GoalStatus } from '@10db/contracts';
import { z } from 'zod';
import type { CommandDeps } from './commands';
import { TendbError } from './errors';
import { GoalListView, ProjectView, TaskView } from './api-views';

async function read<S extends z.ZodType>(
  deps: CommandDeps,
  path: string,
  schema: S,
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await deps.api('GET', path));
  if (!parsed.success) {
    throw new TendbError(
      `GET ${path} answered something this skill doesn't understand: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** A status as the Factory view says it: `not_started` reads "not started". */
const statusWords = (status: string): string => status.replaceAll('_', ' ');

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function counts(row: GoalListView['goals'][number]): { open: number; done: number } {
  const { merged, inReview, total } = row.digest.progress;
  return { open: total - merged - inReview, done: merged + inReview };
}

/**
 * A project's goals that are not done, for `context`. The list's digest is read, never the digest
 * route, which marks the goal as viewed.
 */
export async function openGoalsOf(
  deps: CommandDeps,
  projectId: string,
): Promise<{ id: string; title: string; status: string }[] | string> {
  // `context` is every session's first read, so a goals answer it can't read is said, not fatal.
  let list: GoalListView;
  try {
    list = await read(deps, `/projects/${projectId}/goals`, GoalListView);
  } catch (error) {
    return `couldn't read goals: ${error instanceof Error ? error.message : String(error)}`;
  }
  return list.goals
    .filter((row) => row.digest.status !== GoalStatus.Done)
    .map((row) => ({
      id: row.goal.id,
      title: row.goal.title,
      status: statusWords(row.digest.status),
    }));
}

function block(label: string, text: string | null): string[] {
  return text === null || text.trim() === '' ? [] : ['', `${label}:`, text.trim()];
}

function goalText(goal: GoalDto, status: string, tasks: Map<string, TaskView>): string {
  const lines = [`${goal.id}  ${goal.title}`, `status: ${status}`];
  lines.push(...block('Objective', goal.objective), ...block('Cares most about', goal.caresMost));
  lines.push(...block('Notes', goal.description));
  lines.push('', 'Criteria:');
  if (goal.criteria.length === 0) lines.push('  (none)');
  for (const c of goal.criteria)
    lines.push(`  [${c.state}] ${oneLine(c.text)} (check: ${c.check})`);
  lines.push('', 'Tasks:');
  if (goal.taskIds.length === 0) lines.push('  (none)');
  for (const id of goal.taskIds) {
    const t = tasks.get(id);
    const deps = t && t.dependsOn.length > 0 ? `  depends on: ${t.dependsOn.join(', ')}` : '';
    lines.push(
      `  ${id}\t${t?.boardStatus ?? t?.status ?? 'unknown'}\t${t?.title ?? '(not listed)'}${deps}`,
    );
  }
  return lines.join('\n');
}

/** Prints a project's goals, one tab-separated line each, or one goal in full. Reads only. */
export async function goalsCommand(args: readonly string[], deps: CommandDeps): Promise<void> {
  const [ref, goalId] = args;
  if (!ref) throw new TendbError('usage: goals <projectId|name> [goalId]');
  const projects = await read(deps, '/projects', z.array(ProjectView));
  const project = projects.find((p) => p.id === ref) ?? projects.find((p) => p.name === ref);
  if (!project) {
    throw new TendbError(
      `No project ${ref}. Projects: ${projects.map((p) => `${p.name} (${p.id})`).join(', ')}`,
    );
  }
  const list = await read(deps, `/projects/${project.id}/goals`, GoalListView);
  if (goalId === undefined) {
    if (list.goals.length === 0) deps.out(`${project.name} has no goals.`);
    for (const row of list.goals) {
      const { open, done } = counts(row);
      deps.out(
        [
          row.goal.id,
          statusWords(row.digest.status),
          oneLine(row.goal.title),
          `${String(open)} open`,
          `${String(done)} done`,
        ].join('\t'),
      );
    }
    return;
  }
  const row = list.goals.find((r) => r.goal.id === goalId);
  if (!row) {
    throw new TendbError(
      `No goal ${goalId} in ${project.name}. Run goals ${project.name} to list them.`,
    );
  }
  const goal = await read(deps, `/goals/${goalId}`, GoalDto);
  const tasks = await read(deps, `/projects/${project.id}/tasks`, z.array(TaskView));
  deps.out(goalText(goal, statusWords(row.digest.status), new Map(tasks.map((t) => [t.id, t]))));
}
