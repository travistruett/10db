import {
  InvalidError,
  kindsOfTask,
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
  type PlanRef,
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
  findDocument,
  getAttachmentRevision,
  getProject,
  listKinds,
  getShape,
  getShapeEntry,
  getTask,
  getTaskContext,
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
  upsertTaskContext,
  type DbReader,
  type ShapeProposalRow,
  type WriteContext,
} from '@10db/db';
import { proposePlacement } from '../placement';
import { appendRevision } from '../plan-record';
import { removedKeys } from './validate';
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

/** Why a task's areas can't change because a join of it is pending, or null when none is. */
export type JoiningProblem = (taskId: TaskId) => string | null;

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
          ? 'was converted and then taken back (propose it again under the same key once its goal is converted)'
          : `is ${row.state}`;
  return `${gone}, so it cannot hold a question`;
}

/** The revision a task's plan section names in this Plan, or why it names none. */
function pinnedRevision(
  db: DbReader,
  shapeId: ShapeId,
  title: string,
  ref: PlanRef,
):
  | { revisionId: NonNullable<ReturnType<typeof getAttachmentRevision>>['id'] }
  | { problem: string } {
  const document = findDocument(db, shapeId, ref.document);
  const revision = document ? getAttachmentRevision(db, document.id, ref.revision) : undefined;
  if (revision === undefined)
    return {
      problem: `${title}: its plan document ${ref.document} has no revision ${String(ref.revision)} here`,
    };
  const slugs = new Set(revision.sections.map((s) => s.slug));
  const missing = [ref.section, ...ref.shared].find((slug) => !slugs.has(slug));
  return missing === undefined
    ? { revisionId: revision.id }
    : {
        problem: `${title}: its plan section ${ref.document}#${missing} is not in revision ${String(ref.revision)} of ${ref.document}`,
      };
}

/**
 * Why a task's cites can't be carried: each must be an entry or a decision proposal of the Plan that
 * is still pending or was converted, not one dropped or replaced.
 */
function citeProblems(
  db: DbReader,
  shapeId: ShapeId,
  rows: readonly ShapeProposalRow[],
  title: string,
  cites: readonly string[],
): string[] {
  const live: readonly ShapeProposalState[] = [
    ShapeProposalState.Pending,
    ShapeProposalState.Accepted,
  ];
  const decisions = new Set(
    rows.filter((r) => r.kind === 'decision' && live.includes(r.state)).map((r) => r.key),
  );
  return cites
    .filter((key) => !decisions.has(key) && getShapeEntry(db, shapeId, key) === undefined)
    .map((key) => `${title}: it cites ${key}, which is no entry or decision of this Plan`);
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
  joiningProblem: JoiningProblem = () => null,
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

  // Keys whose task is cancelled, or is by this call: the same refusal in either order of selecting.
  const removed = new Set([
    ...world.removedTasks,
    ...removedKeys(
      world.convertedTasks,
      new Set(
        pending
          .filter((r) => r.kind === 'remove_task')
          .map((r) => ShapeProposalBody.remove_task.parse(r.body).taskId),
      ),
    ),
  ]);

  // Dependencies: each must be a converted task or one that is selected too. A removed task's key
  // stays converted, so only a pending row that reuses it can be depended on.
  const wait = new Map<ShapeProposalId, Set<ShapeProposalId>>();
  const needs = (row: ShapeProposalRow, from: string, keys: readonly string[]): void => {
    for (const key of keys) {
      if (world.convertedTasks.has(key) && !removed.has(key)) continue;
      const owner = owners.get(key);
      if (owner === undefined) {
        errors.push(
          removed.has(key)
            ? `${from} depends on ${key}, which was removed, so nothing can depend on it`
            : `${from} depends on ${key}, and no proposal has that key`,
        );
      } else if (!selectedIds.has(owner.row.id)) {
        errors.push(`${from} depends on ${owner.title}, which isn't selected`);
      } else if (owner.row.id !== row.id) {
        const set = wait.get(row.id) ?? new Set<ShapeProposalId>();
        set.add(owner.row.id);
        wait.set(row.id, set);
      }
    }
  };
  // Only a removed task's key may be taken again; a live one would get a second task under it.
  const takenKey = (row: ShapeProposalRow, key: string): void => {
    if (world.convertedTasks.has(key) && !removed.has(key))
      errors.push(
        `${row.key}: ${row.key === key ? 'it' : `its task ${key}`} takes the key of a task this conversation converted, which is still live; select its removal too, or propose the task under another key`,
      );
  };
  for (const row of efforts) {
    if (row.kind === 'goal')
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks) {
        needs(row, t.title, t.dependsOnOutside);
        takenKey(row, t.key);
      }
    else {
      const task = ShapeProposalBody.task.parse(row.body);
      needs(row, task.title, task.dependsOn);
      takenKey(row, row.key);
    }
  }

  // Plan pins: each task's section must be in its revision here, and each cite in the Plan.
  const pin = (title: string, planRef: PlanRef | undefined, cites: readonly string[]): void => {
    if (planRef !== undefined) {
      const found = pinnedRevision(ctx.tx, shapeId, title, planRef);
      if ('problem' in found) errors.push(found.problem);
    }
    errors.push(...citeProblems(ctx.tx, shapeId, rows, title, cites));
  };
  for (const row of efforts) {
    if (row.kind === 'goal')
      for (const t of ShapeProposalBody.goal.parse(row.body).tasks)
        pin(t.title, t.planRef, t.cites);
    else {
      const task = ShapeProposalBody.task.parse(row.body);
      pin(task.title, task.planRef, task.cites);
    }
  }
  for (const row of pending.filter((r) => r.kind === 'change_task')) {
    const change = ShapeProposalBody.change_task.parse(row.body);
    pin(row.key, change.planRef, change.cites ?? []);
    if (
      change.planRef === undefined &&
      change.cites !== undefined &&
      getTaskContext(ctx.tx, change.taskId) === undefined
    )
      errors.push(`${row.key}: its cites need a plan section, and the task has none`);
  }

  // Landings: every task must be one Convert made or one it makes now, and not in a landing yet.
  for (const row of pending.filter((r) => r.kind === 'landing')) {
    const landing = ShapeProposalBody.landing.parse(row.body);
    for (const key of landing.keys) {
      const converted = removed.has(key) ? undefined : world.convertedTasks.get(key);
      if (converted !== undefined) {
        if (world.placeOf(converted)?.landingGroup)
          errors.push(`${landing.title} includes ${key}, which is already in a landing`);
        continue;
      }
      const owner = owners.get(key);
      if (owner === undefined)
        errors.push(
          removed.has(key)
            ? `${landing.title} includes ${key}, which was removed, so it cannot be in a landing`
            : `${landing.title} includes ${key}, and no proposal has that key`,
        );
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
    if (row.kind === 'task') {
      // An addition names its goal by id. Remove Draft Goal takes that goal back and a converted
      // goal gets a new id, so the addition has to be stated again against it, or dropped.
      const goalId = ShapeProposalBody.task.parse(row.body).goalId;
      if (goalId !== undefined && !world.convertedGoals.has(goalId))
        errors.push(
          `${row.key} is added to goal ${goalId}, which no longer exists: state it again against the goal's current id, or drop it`,
        );
    } else if (row.kind === 'decision') {
      const record = ShapeProposalBody.decision.parse(row.body);
      const problem =
        record.supersedes === undefined ? null : world.decisionProblem(record.supersedes);
      if (problem !== null) errors.push(`${row.key} supersedes ${problem}`);
      if (!record.lasting && record.supersedes !== undefined)
        errors.push(
          `${row.key} is for this effort only, so it cannot supersede a decision in Knowledge; make it lasting or drop supersedes`,
        );
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
      if (about === undefined || goalIds.has(about)) continue;
      // A removed task's key stays converted; only a pending row that reuses it can hold the question.
      if (world.convertedTasks.has(about) && !removed.has(about)) continue;
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
          removed.has(about)
            ? `${row.key} is about ${about}, which was removed, so it cannot hold a question`
            : held !== undefined
              ? `${row.key} is about ${about}, which ${unfitForQuestion(held)}`
              : goalOf !== undefined
                ? `${row.key} is about ${about}, whose goal ${goalOf.key} ${unfitForQuestion(goalOf)}`
                : `${row.key} is about ${about}, and no proposal has that key`,
        );
      } else if (!selectedIds.has(owner.row.id))
        errors.push(`${row.key} is about ${owner.title}, which isn't selected`);
    } else if (row.kind === 'change_task' || row.kind === 'remove_task') {
      const body = ShapeProposalBody[row.kind].parse(row.body);
      // A join still pending has written no workstream, so it reads as unstarted, and the areas and
      // placement it would write here would collide with it (task placement spec, P3).
      const problem =
        world.unstartedProblem(body.taskId) ??
        (row.kind === 'change_task' &&
        ShapeProposalBody.change_task.parse(row.body).areas !== undefined
          ? joiningProblem(body.taskId)
          : null);
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

  /** Pins a task to its section; the checks above found the revision. */
  const pinTask = (taskId: TaskId, planRef: PlanRef, cites: readonly string[]): void => {
    const found = pinnedRevision(ctx.tx, shapeId, taskId, planRef);
    if ('problem' in found) throw new InvalidError(found.problem);
    upsertTaskContext(ctx, {
      taskId,
      shapeId,
      revisionId: found.revisionId,
      section: planRef.section,
      shared: planRef.shared,
      cites,
    });
  };

  for (const row of sorted.order) {
    if (row.kind === 'goal') {
      const goal = ShapeProposalBody.goal.parse(row.body);
      const outside = Object.fromEntries(
        goal.tasks
          .filter((t) => t.dependsOnOutside.length > 0)
          .map((t) => [t.key, t.dependsOnOutside]),
      );
      // A goal task may take a removed task's key, which `taskIds` still maps to the cancelled task;
      // that key is the brief's own, not an outside one. A live key stays outside, so the store
      // still refuses a collision the check above missed rather than writing a second task.
      const briefKeys = new Set(goal.tasks.map((t) => t.key));
      const written = insertGoal(ctx, project.id, {
        brief: goalBrief(goal),
        placeTask: (areas) => proposePlacement(project, { areas, kinds: [] }),
        outsideKeys: new Map(
          [...taskIds].filter(([key]) => !(briefKeys.has(key) && removed.has(key))),
        ),
        dependsOnOutside: outside,
      });
      insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, goalId: written.goal.id });
      goalIds.set(row.key, written.goal.id);
      const ids: TaskId[] = [];
      for (const [key, id] of written.taskIds) {
        taskIds.set(key, id);
        ids.push(id);
        insertShapeLink(ctx, { shapeId, proposalId: row.id, key, taskId: id });
        // A diagram on a goal's task, kept by its key, follows the task as one on a task row does.
        linkShapeAttachments(ctx, shapeId, key, { taskId: id });
      }
      for (const t of goal.tasks) {
        const id = written.taskIds.get(t.key);
        if (id !== undefined && t.planRef !== undefined) pinTask(id, t.planRef, t.cites);
      }
      made.set(row.id, { goalId: written.goal.id, taskIds: ids });
      // The proposed eval is kept as an attachment on the goal, with the spec (§7).
      if (goal.eval !== undefined) {
        const body = JSON.stringify(goal.eval, null, 2);
        const evalId = upsertShapeAttachment(ctx, { shapeId, kind: 'eval', key: row.key, body });
        appendRevision(ctx, evalId, body, {
          note: null,
          author: null,
          bundleNumber: null,
          authoredAt: null,
        });
      }
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
      const input = { ...base, acceptanceCriteria: task.criteria, areas: task.areas };
      // The placement rule runs on every task Convert makes (task placement spec, P2).
      const placement = proposePlacement(project, { areas: task.areas, kinds: [] });
      const written =
        task.goalId === undefined
          ? insertTask(ctx, project.id, input, placement)
          : insertGoalTask(ctx, project.id, task.goalId, input, placement);
      taskIds.set(row.key, written.id);
      insertShapeLink(ctx, { shapeId, proposalId: row.id, key: row.key, taskId: written.id });
      if (task.planRef !== undefined) pinTask(written.id, task.planRef, task.cites);
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
    // A decision for this effort only stays in the Plan's record: accepted, never in Knowledge.
    if (!record.lasting) {
      made.set(row.id, { taskIds: [] });
      continue;
    }
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
  // A goal may take a removed task's key: `taskIds` still maps it to the cancelled task, unless this
  // call made a new one under it.
  const liveTask = (key: string): TaskId | undefined => {
    const id = taskIds.get(key);
    return removed.has(key) && id === world.convertedTasks.get(key) ? undefined : id;
  };
  for (const row of pending.filter((r) => r.kind === 'question')) {
    const question = ShapeProposalBody.question.parse(row.body);
    const goalId = question.about === undefined ? undefined : goalIds.get(question.about);
    const taskId = question.about === undefined ? undefined : liveTask(question.about);
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
    // Changed areas can now match the placement rule; the store moves the task only if it hasn't
    // started and the builder hasn't placed it, as for an edit through the task API.
    const before = change.areas === undefined ? undefined : getTask(ctx.tx, change.taskId);
    const fields = {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.description === undefined ? {} : { description: change.description }),
      ...(change.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: change.acceptanceCriteria }),
      ...(change.areas === undefined ? {} : { areas: change.areas }),
    };
    // A change of only its plan pin leaves the task's own fields as they are.
    if (Object.keys(fields).length > 0)
      patchTask(
        ctx,
        change.taskId,
        fields,
        change.areas === undefined || before === undefined
          ? undefined
          : proposePlacement(project, {
              areas: change.areas,
              kinds: kindsOfTask(before.kinds, listKinds(ctx.tx)),
            }),
      );
    const held = getTaskContext(ctx.tx, change.taskId);
    if (change.planRef !== undefined)
      pinTask(change.taskId, change.planRef, change.cites ?? held?.cites ?? []);
    // New cites alone keep the task's stored pin as it is; there is no ref to look up again.
    else if (change.cites !== undefined && held !== undefined)
      upsertTaskContext(ctx, {
        taskId: change.taskId,
        shapeId: held.shapeId,
        revisionId: held.revisionId,
        section: held.section,
        shared: held.shared,
        cites: change.cites,
      });
    made.set(row.id, { taskIds: [change.taskId] });
  }
  for (const row of pending.filter((r) => r.kind === 'remove_task')) {
    const removal: PlanRemoval = ShapeProposalBody.remove_task.parse(row.body);
    // Cancelling detaches the questions stored under the task, so none points at it.
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
