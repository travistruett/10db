import {
  KnowledgeScope,
  PrincipleKind,
  PrincipleStatus,
  ShapeProposalBody,
  ShapeProposalState,
  ShapeState,
  topicKeyFrom,
  type DecisionId,
  type GoalBrief,
  type GoalId,
  type KnowledgeTarget,
  type PlanChange,
  type PlanGoal,
  type PlanPrincipleRecord,
  type PlanRemoval,
  type PrincipleId,
  type ProjectId,
  type ShapeId,
  type ShapeProposalId,
  type ShapeProposalKind,
  type ShapeQuestionId,
  type TaskId,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  cancelTask,
  getProject,
  getShape,
  insertDecision,
  insertGoal,
  insertGoalTask,
  insertLandingGroup,
  insertPrinciple,
  insertShapeLink,
  insertShapeQuestion,
  insertSource,
  insertTask,
  linkShapeAttachments,
  listShapeLinks,
  listShapeProposals,
  patchShape,
  patchShapeProposal,
  patchTask,
  upsertShapeAttachment,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import { buildPlanWorld, tasksInside } from './world';

// Shape spec §11. Convert writes the selected proposals into goals, tasks, decisions, principles and
// questions in the caller's transaction, so a refusal or a failure leaves nothing behind, and it
// starts nothing.

/** What one proposal became. */
export interface ConvertedRow {
  readonly key: string;
  readonly kind: ShapeProposalKind;
  readonly goalId?: GoalId;
  readonly taskIds: readonly TaskId[];
  readonly decisionId?: DecisionId;
  readonly principleId?: PrincipleId;
  readonly questionId?: ShapeQuestionId;
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

/** Where a principle record applies: the builder, the project, or one of its areas. */
function principleTarget(record: PlanPrincipleRecord, projectId: ProjectId): KnowledgeTarget {
  switch (record.scope) {
    case KnowledgeScope.You:
      return { scope: KnowledgeScope.You };
    case KnowledgeScope.Project:
      return { scope: KnowledgeScope.Project, projectId };
    case KnowledgeScope.Area:
      // The record names its area (the contract refuses an area scope without one), and Convert has
      // already checked the project has it.
      return { scope: KnowledgeScope.Area, projectId, area: record.area ?? '' };
  }
}

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

/** Why a stored row with this key cannot hold a question, as the end of a sentence. */
function unfitForQuestion(row: ShapeProposalRow): string {
  if (row.kind !== 'goal' && row.kind !== 'task')
    return `is a ${row.kind.replaceAll('_', ' ')}, not a goal or task`;
  const gone =
    row.state === ShapeProposalState.Rejected
      ? 'was dropped'
      : row.state === ShapeProposalState.Superseded
        ? 'was replaced by a later plan'
        : row.state === ShapeProposalState.Accepted
          ? 'was converted and then taken back'
          : `is ${row.state}`;
  return `${gone}, so it cannot hold a question`;
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

  // Landings: every task must be one Convert made or one it makes now, and not in a landing yet.
  for (const row of pending.filter((r) => r.kind === 'landing')) {
    const landing = ShapeProposalBody.landing.parse(row.body);
    for (const key of landing.keys) {
      const converted = world.convertedTasks.get(key);
      if (converted !== undefined) {
        if (world.placeOf(converted)?.landingGroup)
          errors.push(`${landing.title} includes ${key}, which is already in a landing`);
        continue;
      }
      const owner = owners.get(key);
      if (owner === undefined)
        errors.push(`${landing.title} includes ${key}, and no proposal has that key`);
      else if (!selectedIds.has(owner.row.id))
        errors.push(`${landing.title} includes ${owner.title}, which isn't selected`);
    }
  }

  const project = getProject(ctx.tx, getShape(ctx.tx, shapeId).projectId);
  const goalIds = new Map<string, GoalId>();
  for (const link of listShapeLinks(ctx.tx, shapeId))
    if (link.goalId !== null) goalIds.set(link.key, link.goalId);

  // Records, questions, changes and removals are judged again as they stand now.
  for (const row of pending) {
    if (row.kind === 'decision') {
      const record = ShapeProposalBody.decision.parse(row.body);
      const problem =
        record.supersedes === undefined ? null : world.decisionProblem(record.supersedes);
      if (problem !== null) errors.push(`${row.key} supersedes ${problem}`);
    } else if (row.kind === 'principle') {
      const record = ShapeProposalBody.principle.parse(row.body);
      if (
        record.scope === KnowledgeScope.Area &&
        !project.areas.some((a) => a.name === record.area)
      )
        errors.push(`${row.key}: ${project.name} has no area named ${record.area ?? ''}`);
    } else if (row.kind === 'question') {
      const about = ShapeProposalBody.question.parse(row.body).about;
      // A question belongs to a goal or task that is converted already or is converted with it.
      if (about === undefined || world.convertedTasks.has(about) || goalIds.has(about)) continue;
      const goal = rows.find((r) => r.kind === 'goal' && r.key === about && r.state === 'pending');
      const owner =
        owners.get(about) ??
        (goal === undefined
          ? undefined
          : { title: ShapeProposalBody.goal.parse(goal.body).title, row: goal });
      if (owner === undefined) {
        // A row may hold the key and still be unable to hold a question: say which way.
        const held = rows.find((r) => r.key === about);
        const goalOf = rows.find((r) => tasksInside(r).includes(about));
        errors.push(
          held !== undefined
            ? `${row.key} is about ${about}, which ${unfitForQuestion(held)}`
            : goalOf !== undefined
              ? `${row.key} is about ${about}, whose goal ${goalOf.key} ${unfitForQuestion(goalOf)}`
              : `${row.key} is about ${about}, and no proposal has that key`,
        );
      } else if (!selectedIds.has(owner.row.id))
        errors.push(`${row.key} is about ${owner.title}, which isn't selected`);
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
  const taskIds = new Map<string, TaskId>(world.convertedTasks);
  const made = new Map<
    ShapeProposalId,
    {
      goalId?: GoalId;
      taskIds: TaskId[];
      decisionId?: DecisionId;
      principleId?: PrincipleId;
      questionId?: ShapeQuestionId;
    }
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
      goalIds.set(row.key, written.goal.id);
      const ids: TaskId[] = [];
      for (const [key, id] of written.taskIds) {
        taskIds.set(key, id);
        ids.push(id);
        insertShapeLink(ctx, { shapeId, proposalId: row.id, key, taskId: id });
      }
      made.set(row.id, { goalId: written.goal.id, taskIds: ids });
      // The proposed eval is kept as an attachment on the goal, with the spec (§7).
      if (goal.eval !== undefined)
        upsertShapeAttachment(ctx, {
          shapeId,
          kind: 'eval',
          key: row.key,
          body: JSON.stringify(goal.eval, null, 2),
        });
      linkShapeAttachments(ctx, shapeId, row.key, { goalId: written.goal.id });
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
      linkShapeAttachments(ctx, shapeId, row.key, { taskId: written.id });
    }
  }

  // Each kept landing becomes a group its tasks belong to (§10.4), once the tasks exist.
  for (const row of pending.filter((r) => r.kind === 'landing')) {
    const landing = ShapeProposalBody.landing.parse(row.body);
    const members = landing.keys.flatMap((key) => taskIds.get(key) ?? []);
    insertLandingGroup(ctx, {
      projectId: project.id,
      title: landing.title,
      taskIds: members,
      shapeId,
    });
    made.set(row.id, { taskIds: members });
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

  // Converting is the builder's own confirmation, so a principle is written confirmed. It replaces
  // the current one with the same topic key and scope, which `insertPrinciple` finds.
  for (const row of pending.filter((r) => r.kind === 'principle')) {
    const record = ShapeProposalBody.principle.parse(row.body);
    const principle = insertPrinciple(ctx, {
      target: principleTarget(record, project.id),
      statement: record.statement,
      rationale: record.rationale,
      kind: record.principleKind ?? PrincipleKind.Policy,
      topicKey: record.topicKey ?? topicKeyFrom(record.statement),
      status: PrincipleStatus.Confirmed,
      sourceId: insertSource(ctx, 'builder', { shapeId, proposalKey: row.key }),
      sourceQuote: null,
      speaker: BUILDER_HANDLE,
      confirmedBy: BUILDER_HANDLE,
    });
    insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, principleId: principle.id });
    made.set(row.id, { taskIds: [], principleId: principle.id });
  }

  // A question is only stored, under the goal or task it is about; nothing is sent.
  for (const row of pending.filter((r) => r.kind === 'question')) {
    const question = ShapeProposalBody.question.parse(row.body);
    const goalId = question.about === undefined ? undefined : goalIds.get(question.about);
    const taskId = question.about === undefined ? undefined : taskIds.get(question.about);
    const stored = insertShapeQuestion(ctx, {
      shapeId,
      proposalId: row.id,
      key: row.key,
      text: question.text,
      forWho: question.for,
      sourceMessageIds: question.sourceMessageIds ?? [],
      ...(goalId === undefined ? {} : { goalId }),
      ...(taskId === undefined ? {} : { taskId }),
    });
    insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, questionId: stored.id });
    made.set(row.id, { taskIds: [], questionId: stored.id });
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
    const principleId = mine.find((l) => l.principleId !== null)?.principleId;
    const questionId = mine.find((l) => l.questionId !== null)?.questionId;
    return {
      key: row.key,
      kind: row.kind,
      taskIds: mine.flatMap((l) => (l.taskId === null ? [] : [l.taskId])),
      ...(goalId ? { goalId } : {}),
      ...(decisionId ? { decisionId } : {}),
      ...(principleId ? { principleId } : {}),
      ...(questionId ? { questionId } : {}),
    };
  });
  return { ok: true, createdNow: pending.length, results };
}
