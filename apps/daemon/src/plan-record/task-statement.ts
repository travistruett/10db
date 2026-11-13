import {
  ShapeProposalBody,
  type BundleTask,
  type PlanGoal,
  type PlanRef,
  type TaskSize,
} from '@10db/contracts';
import { canonicalJson } from './lookup';

// A converted task as the Plan's proposals last stated it. A re-import compares the bundle's task with
// this, not with the board, so an edit the builder made on the board is never proposed back.

export interface TaskStatement {
  readonly title: string;
  readonly headline: string;
  readonly why: string;
  readonly description: string;
  readonly criteria: readonly string[];
  readonly areas: readonly string[];
  readonly size: TaskSize | null;
  readonly planRef: PlanRef | null;
  readonly cites: readonly string[];
  /** Every key it depends on, inside its goal or not, sorted. */
  readonly dependsOn: readonly string[];
}

export type StatementField = keyof TaskStatement;

export const STATEMENT_FIELDS: readonly StatementField[] = [
  'title',
  'headline',
  'why',
  'description',
  'criteria',
  'areas',
  'size',
  'planRef',
  'cites',
  'dependsOn',
];

const sorted = (keys: readonly string[]): string[] => [...keys].sort();

/** A bundle task's statement, its planRef already in the record's revision numbers. */
export function bundleStatement(task: BundleTask, planRef: PlanRef | null): TaskStatement {
  return {
    title: task.title,
    headline: task.headline,
    why: task.why,
    description: task.description,
    criteria: task.criteria,
    areas: task.areas,
    size: task.size,
    planRef,
    cites: task.cites,
    dependsOn: sorted(task.dependsOn),
  };
}

/** The fields whose values differ between two statements. */
export function changedFields(now: TaskStatement, was: TaskStatement): StatementField[] {
  return STATEMENT_FIELDS.filter((f) => canonicalJson(now[f]) !== canonicalJson(was[f]));
}

/** A stored proposal body as canonical JSON text, parsed back; null for an empty one. */
const parsedText = (text: string): unknown => (text === '' ? null : JSON.parse(text));

/** The statement of task `key` in a stored goal proposal's body, or null. */
export function statedInGoal(goalBody: string, key: string): TaskStatement | null {
  const goal = ShapeProposalBody.goal.safeParse(parsedText(goalBody));
  const task = goal.success ? goal.data.tasks.find((t) => t.key === key) : undefined;
  if (task === undefined) return null;
  return {
    title: task.title,
    headline: task.headline,
    why: task.why,
    description: task.description,
    criteria: task.criteria,
    areas: task.areas,
    size: task.size ?? null,
    planRef: task.planRef ?? null,
    cites: task.cites,
    dependsOn: sorted([...task.depends_on, ...task.dependsOnOutside]),
  };
}

/** The statement in a stored task proposal's body (a loose task or an addition), or null. */
export function statedAsTask(taskBody: string): TaskStatement | null {
  const task = ShapeProposalBody.task.safeParse(parsedText(taskBody));
  if (!task.success) return null;
  return {
    title: task.data.title,
    headline: task.data.headline,
    why: task.data.why,
    description: task.data.description,
    criteria: task.data.criteria,
    areas: task.data.areas,
    size: task.data.size ?? null,
    planRef: task.data.planRef ?? null,
    cites: task.data.cites,
    dependsOn: sorted(task.data.dependsOn),
  };
}

/** The fields a statement sets on a stored proposal's task, keeping its own annotations. */
function statedFields(now: TaskStatement) {
  return {
    title: now.title,
    headline: now.headline,
    why: now.why,
    description: now.description,
    criteria: [...now.criteria],
    areas: [...now.areas],
    ...(now.size === null ? {} : { size: now.size, basis: undefined }),
    planRef: now.planRef ?? undefined,
    cites: [...now.cites],
  };
}

/**
 * A goal proposal's body with task `key` stated anew. `dependsOn` is in the bundle's order and
 * `inside` holds the goal's own task keys.
 */
export function restateInGoal(
  goal: PlanGoal,
  key: string,
  now: TaskStatement,
  dependsOn: readonly string[],
  inside: ReadonlySet<string>,
): PlanGoal {
  return {
    ...goal,
    tasks: goal.tasks.map((t) =>
      t.key === key
        ? {
            ...t,
            ...statedFields(now),
            depends_on: dependsOn.filter((k) => inside.has(k)),
            dependsOnOutside: dependsOn.filter((k) => !inside.has(k)),
          }
        : t,
    ),
  };
}

/** A task proposal's body stated anew, `dependsOn` in the bundle's order; null when it doesn't parse. */
export function restateAsTask(
  taskBody: string,
  now: TaskStatement,
  dependsOn: readonly string[],
): unknown {
  const task = ShapeProposalBody.task.safeParse(parsedText(taskBody));
  if (!task.success) return null;
  return { ...task.data, ...statedFields(now), dependsOn: [...dependsOn] };
}

/** A stored goal proposal's body, parsed; null when it doesn't parse. */
export function parsedGoal(goalBody: string): PlanGoal | null {
  const goal = ShapeProposalBody.goal.safeParse(parsedText(goalBody));
  return goal.success ? goal.data : null;
}
