import {
  ShapeProposalBody,
  ShapeProposalState,
  ShapeState,
  type DecisionId,
  type GoalBrief,
  type GoalId,
  type PlanChange,
  type PlanGoal,
  type PlanRemoval,
  type ShapeId,
  type ShapeProposalId,
  type ShapeProposalKind,
  type TaskId,
} from '@10db/contracts';
import {
  cancelTask,
  getProject,
  getShape,
  insertDecision,
  insertGoal,
  insertGoalTask,
  insertShapeLink,
  insertSource,
  insertTask,
  listShapeLinks,
  listShapeProposals,
  patchShape,
  patchShapeProposal,
  patchTask,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import { buildPlanWorld } from './world';

// Shape spec §11. Convert writes the selected proposals into goals, tasks and decisions in the
// caller's transaction, so a refusal or a failure leaves nothing behind, and it starts nothing.

/** What one proposal became. */
export interface ConvertedRow {
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly goalId?: GoalId;
  readonly taskIds: readonly TaskId[];
  readonly decisionId?: DecisionId;
}

export type ConvertOutcome =
  | {
      readonly ok: true;
      /** How many proposals this call converted; a repeated Convert reports 0. */
      readonly createdNow: number;
      /** What each selected proposal became, in the order selected. */
      readonly results: readonly ConvertedRow[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The kinds Convert writes today; landings, principles and questions come with their tables. */
const WRITTEN: ReadonlySet<ShapeProposalKind> = new Set([
  'goal',
  'task',
  'decision',
  'change_task',
  'remove_task',
]);

/** A task a proposal holds, by its key: the title to name it by, and the row it is in. */
interface Owner {
  readonly title: string;
  readonly row: ShapeProposalRow;
}

type Task = ReturnType<typeof ShapeProposalBody.task.parse>;

function goalBrief(goal: PlanGoal): GoalBrief {
  return {
    title: goal.title,
    objective: goal.objective,
    cares_most: goal.cares_most,
    criteria: goal.criteria,
    people: goal.people,
    tasks: goal.tasks.map((t) => ({
      key: t.key,
      title: t.title,
      headline: t.headline,
      why: t.why,
      description: t.description,
      criteria: t.criteria,
      areas: t.areas,
      depends_on: t.depends_on,
    })),
  };
}

/** Each effort in the order its dependencies need, or the keys of a cycle between efforts. */
function inDependencyOrder(
  efforts: readonly ShapeProposalRow[],
  dependsOn: ReadonlyMap<ShapeProposalId, ReadonlySet<ShapeProposalId>>,
): { order: ShapeProposalRow[] } | { cycle: string[] } {
  const order: ShapeProposalRow[] = [];
  const done = new Set<ShapeProposalId>();
  let remaining = [...efforts];
  while (remaining.length > 0) {
    const ready = remaining.filter((e) =>
      [...(dependsOn.get(e.id) ?? [])].every((d) => done.has(d)),
    );
    if (ready.length === 0) return { cycle: remaining.map((e) => e.key) };
    for (const e of ready) {
      order.push(e);
      done.add(e.id);
    }
    remaining = remaining.filter((e) => !done.has(e.id));
  }
  return { order };
}

/**
 * Converts the selected proposals. Answers every refusal at once and writes nothing for it. A
 * proposal already converted is not converted again; its result is what the first Convert made.
 */
export function convertProposals(
  ctx: WriteContext,
  shapeId: ShapeId,
  proposalIds: readonly ShapeProposalId[],
): ConvertOutcome {
  const rows = listShapeProposals(ctx.tx, shapeId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const errors: string[] = [];
  const selected: ShapeProposalRow[] = [];
  for (const id of new Set(proposalIds)) {
    const row = byId.get(id);
    if (row === undefined) errors.push(`${id} is not a proposal of this conversation`);
    else if (!WRITTEN.has(row.kind))
      errors.push(`${row.key} is a ${row.kind}, which Convert cannot write yet`);
    else if (row.state !== ShapeProposalState.Pending && row.state !== ShapeProposalState.Accepted)
      errors.push(`${row.key} is ${row.state}, so it cannot be converted`);
    else selected.push(row);
  }
  const pending = selected.filter((r) => r.state === ShapeProposalState.Pending);

  const world = buildPlanWorld(ctx.tx, shapeId);

  // Where each pending task key lives, so a missing dependency is named by its title.
  const owners = new Map<string, Owner>();
  for (const row of rows.filter((r) => r.state === ShapeProposalState.Pending)) {
    if (row.kind === 'goal') {
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks)
        owners.set(t.key, { title: t.title, row });
    } else if (row.kind === 'task') {
      owners.set(row.key, { title: ShapeProposalBody.task.parse(row.body).title, row });
    }
  }
  const selectedIds = new Set(pending.map((r) => r.id));
  const efforts = pending.filter((r) => r.kind === 'goal' || r.kind === 'task');

  // Dependencies: each must be a converted task or one that is selected too.
  const wait = new Map<ShapeProposalId, Set<ShapeProposalId>>();
  const needs = (row: ShapeProposalRow, from: string, keys: readonly string[]): void => {
    for (const key of keys) {
      if (world.convertedTasks.has(key)) continue;
      const owner = owners.get(key);
      if (owner === undefined) {
        errors.push(`${from} depends on ${key}, and no proposal has that key`);
      } else if (!selectedIds.has(owner.row.id)) {
        errors.push(`${from} depends on ${owner.title}, which isn't selected`);
      } else if (owner.row.id !== row.id) {
        const set = wait.get(row.id) ?? new Set<ShapeProposalId>();
        set.add(owner.row.id);
        wait.set(row.id, set);
      }
    }
  };
  for (const row of efforts) {
    if (row.kind === 'goal')
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks)
        needs(row, t.title, t.dependsOnOutside);
    else {
      const task = ShapeProposalBody.task.parse(row.body);
      needs(row, task.title, task.dependsOn);
    }
  }

  // Records, changes and removals are judged again as they stand now.
  for (const row of pending) {
    if (row.kind === 'decision') {
      const record = ShapeProposalBody.decision.parse(row.body);
      const problem =
        record.supersedes === undefined ? null : world.decisionProblem(record.supersedes);
      if (problem !== null) errors.push(`${row.key} supersedes ${problem}`);
    } else if (row.kind === 'change_task' || row.kind === 'remove_task') {
      const body = ShapeProposalBody[row.kind].parse(row.body);
      const problem = world.unstartedProblem(body.taskId);
      if (problem !== null) errors.push(`${row.key}: ${problem}`);
    }
  }

  const sorted = inDependencyOrder(efforts, wait);
  if ('cycle' in sorted)
    errors.push(
      `These depend on each other's tasks and cannot be ordered: ${sorted.cycle.join(', ')}`,
    );
  if (errors.length > 0 || 'cycle' in sorted) return { ok: false, errors };

  // Writes.
  const project = getProject(ctx.tx, getShape(ctx.tx, shapeId).projectId);
  const taskIds = new Map<string, TaskId>(world.convertedTasks);
  const made = new Map<
    ShapeProposalId,
    { goalId?: GoalId; taskIds: TaskId[]; decisionId?: DecisionId }
  >();

  for (const row of sorted.order) {
    if (row.kind === 'goal') {
      const goal = ShapeProposalBody.goal.parse(row.body);
      const outside = Object.fromEntries(
        goal.tasks
          .filter((t) => t.dependsOnOutside.length > 0)
          .map((t) => [t.key, t.dependsOnOutside]),
      );
      const written = insertGoal(ctx, project.id, {
        brief: goalBrief(goal),
        outsideKeys: new Map(taskIds),
        dependsOnOutside: outside,
      });
      insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, goalId: written.goal.id });
      const ids: TaskId[] = [];
      for (const [key, id] of written.taskIds) {
        taskIds.set(key, id);
        ids.push(id);
        insertShapeLink(ctx, { shapeId, proposalId: row.id, key, taskId: id });
      }
      made.set(row.id, { goalId: written.goal.id, taskIds: ids });
    } else {
      const task: Task = ShapeProposalBody.task.parse(row.body);
      const base = {
        title: task.title,
        headline: task.headline,
        why: task.why,
        description: task.description,
        dependsOn: task.dependsOn.flatMap((key) => taskIds.get(key) ?? []),
      };
      const written =
        task.goalId === undefined
          ? insertTask(ctx, project.id, {
              ...base,
              acceptanceCriteria: task.criteria,
              areas: task.areas,
            })
          : insertGoalTask(ctx, project.id, task.goalId, {
              ...base,
              acceptanceCriteria: task.criteria,
              areas: task.areas,
            });
      taskIds.set(row.key, written.id);
      insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, taskId: written.id });
      made.set(row.id, { taskIds: [written.id] });
    }
  }

  for (const row of pending.filter((r) => r.kind === 'decision')) {
    const record = ShapeProposalBody.decision.parse(row.body);
    const id = insertDecision(ctx, {
      // A builder-wide decision belongs to no project.
      projectId: record.scope === 'you' ? null : project.id,
      question: record.question,
      choice: record.choice,
      rationale: record.rationale,
      decidedBy: 'builder',
      scope: record.scope,
      area: record.area ?? null,
      sourceId: insertSource(ctx, 'builder', { shapeId, proposalKey: row.key }),
      supersedesId: record.supersedes ?? null,
    });
    insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, decisionId: id });
    made.set(row.id, { taskIds: [], decisionId: id });
  }

  for (const row of pending.filter((r) => r.kind === 'change_task')) {
    const change: PlanChange = ShapeProposalBody.change_task.parse(row.body);
    patchTask(ctx, change.taskId, {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.description === undefined ? {} : { description: change.description }),
      ...(change.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: change.acceptanceCriteria }),
      ...(change.areas === undefined ? {} : { areas: change.areas }),
    });
    made.set(row.id, { taskIds: [change.taskId] });
  }
  for (const row of pending.filter((r) => r.kind === 'remove_task')) {
    const removal: PlanRemoval = ShapeProposalBody.remove_task.parse(row.body);
    cancelTask(ctx, removal.taskId);
    made.set(row.id, { taskIds: [removal.taskId] });
  }

  for (const row of pending)
    patchShapeProposal(ctx, row.id, { state: ShapeProposalState.Accepted });
  const left = listShapeProposals(ctx.tx, shapeId).some(
    (r) => r.state === ShapeProposalState.Pending,
  );
  if (pending.length > 0 && !left) patchShape(ctx, shapeId, { state: ShapeState.Converted });

  // What each selected proposal became, including what an earlier Convert made.
  const results: ConvertedRow[] = selected.map((row) => {
    const now = made.get(row.id);
    if (now !== undefined) return { key: row.key, kind: row.kind, ...now };
    const mine = listShapeLinks(ctx.tx, shapeId).filter((l) => l.proposalId === row.id);
    const goalId = mine.find((l) => l.goalId !== null)?.goalId;
    const decisionId = mine.find((l) => l.decisionId !== null)?.decisionId;
    return {
      key: row.key,
      kind: row.kind,
      taskIds: mine.flatMap((l) => (l.taskId === null ? [] : [l.taskId])),
      ...(goalId ? { goalId } : {}),
      ...(decisionId ? { decisionId } : {}),
    };
  });
  return { ok: true, createdNow: pending.length, results };
}
