import {
  CriterionCheck,
  CriterionState,
  EventType,
  GoalBrief,
  GoalState,
  InvalidError,
  mintId,
  NotFoundError,
  type GoalBriefTask,
  type GoalCriterionDto,
  type GoalDto,
  type GoalId,
  type PersonId,
  type ProjectId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import type { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { getTask, insertGoalTask } from './tasks';
import { BUILDER_HANDLE, getPerson } from './team';

// Goals spec docs/superpowers/specs/2026-10-29-10db-goals-design.md §4, §5, §8 (phase 1).

export interface GoalInsert {
  /** The brief's front matter; its `people` are proposals and are not written here. */
  readonly brief: z.input<typeof GoalBrief>;
  /** The notes below the front matter. */
  readonly description?: string;
  /** Absent means the builder. */
  readonly ownerId?: PersonId;
}

/**
 * Writes a `draft` goal with its tasks, their dependencies and its `unproven` criteria. Brief keys
 * become the TaskIds made here. A brief that breaks a rule (a repeated or unknown key, a dependency
 * cycle, an unknown area or person) throws, and the caller's transaction leaves nothing behind.
 */
export function insertGoal(ctx: WriteContext, projectId: ProjectId, input: GoalInsert): GoalDto {
  getProject(ctx.tx, projectId);
  const brief = GoalBrief.parse(input.brief);
  const ownerId = input.ownerId ?? builderId(ctx.tx);
  getPerson(ctx.tx, ownerId);

  const goalId = mintId('Goal');
  ctx.tx
    .insert(schema.goals)
    .values({
      id: goalId,
      projectId,
      title: brief.title,
      objective: brief.objective,
      caresMost: brief.cares_most ?? null,
      description: input.description ?? '',
      ownerId,
      state: GoalState.Draft,
      budget: brief.budget ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();

  const taskIds = new Map<string, TaskId>();
  for (const task of inDependencyOrder(brief.tasks)) {
    const written = insertGoalTask(ctx, projectId, goalId, {
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.criteria,
      areas: task.areas,
      // inDependencyOrder put every task this one depends on before it.
      dependsOn: task.depends_on.flatMap((key) => taskIds.get(key) ?? []),
    });
    taskIds.set(task.key, written.id);
  }

  brief.criteria.forEach((criterion, position) => {
    const where = `Criterion ${String(position + 1)}`;
    let taskId: TaskId | null = null;
    if ('task' in criterion) {
      const named = taskIds.get(criterion.task);
      if (named === undefined)
        throw new InvalidError(`${where}: no task has the key ${criterion.task}`);
      taskId = named;
    }
    ctx.tx
      .insert(schema.goalCriteria)
      .values({
        id: mintId('GoalCriterion'),
        goalId,
        position,
        text: criterion.text,
        check: criterion.check,
        taskId,
        command: criterion.check === CriterionCheck.Command ? (criterion.command ?? null) : null,
        commandApproved: false,
        personId:
          criterion.check === CriterionCheck.Accept && criterion.person !== undefined
            ? personNamed(ctx.tx, criterion.person, where)
            : null,
        state: CriterionState.Unproven,
        proof: [],
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();
  });

  ctx.emit({
    type: EventType.GoalCreated,
    entityType: 'goal',
    entityId: goalId,
    data: { projectId },
  });
  return getGoal(ctx.tx, goalId);
}

function builderId(db: DbReader): PersonId {
  const builder = db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(eq(schema.people.handle, BUILDER_HANDLE))
    .get();
  if (!builder) throw new InvalidError('No owner was given and there is no builder to default to');
  return builder.id;
}

/**
 * An exact handle (unique) wins. Otherwise the name must belong to exactly one person: a name
 * is not unique, and guessing between two people would hand the acceptance to the wrong one.
 */
function personNamed(db: DbReader, name: string, where: string): PersonId {
  const byHandle = db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(eq(schema.people.handle, name))
    .get();
  if (byHandle) return byHandle.id;
  const byName = db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(eq(schema.people.name, name))
    .limit(2)
    .all();
  const [person, other] = byName;
  if (!person) throw new InvalidError(`${where}: nobody is called ${name}`);
  if (other)
    throw new InvalidError(
      `${where}: more than one person is called ${name}; name them by handle instead`,
    );
  return person.id;
}

/**
 * The brief's tasks, each after the tasks it depends on and otherwise in brief order. Refuses a
 * repeated key, a dependency on a key no task has, a dependency listed twice, and a cycle.
 */
function inDependencyOrder(tasks: readonly GoalBriefTask[]): GoalBriefTask[] {
  const byKey = new Map<string, GoalBriefTask>();
  for (const task of tasks) {
    if (byKey.has(task.key)) throw new InvalidError(`Two tasks have the key ${task.key}`);
    byKey.set(task.key, task);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const key of task.depends_on) {
      if (!byKey.has(key))
        throw new InvalidError(`Task ${task.key} depends on ${key}, and no task has that key`);
      if (seen.has(key)) throw new InvalidError(`Task ${task.key} depends on ${key} twice`);
      seen.add(key);
    }
  }

  const ordered: GoalBriefTask[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (task: GoalBriefTask): void => {
    if (done.has(task.key)) return;
    if (visiting.has(task.key))
      throw new InvalidError(`The tasks' dependencies form a cycle through ${task.key}`);
    visiting.add(task.key);
    for (const key of task.depends_on) {
      const dependency = byKey.get(key);
      if (dependency) visit(dependency);
    }
    visiting.delete(task.key);
    done.add(task.key);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
}

type GoalRow = typeof schema.goals.$inferSelect;
type CriterionRow = typeof schema.goalCriteria.$inferSelect;

const criterionDto = (row: CriterionRow): GoalCriterionDto => ({
  id: row.id,
  goalId: row.goalId,
  text: row.text,
  check: row.check,
  taskId: row.taskId,
  command: row.command,
  commandApproved: row.commandApproved,
  personId: row.personId,
  state: row.state,
  proof: row.proof,
  provenAt: row.provenAt,
  provenBy: row.provenBy,
});

function toGoalDto(db: DbReader, row: GoalRow): GoalDto {
  const criteria = db
    .select()
    .from(schema.goalCriteria)
    .where(eq(schema.goalCriteria.goalId, row.id))
    .orderBy(asc(schema.goalCriteria.position))
    .all();
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    objective: row.objective,
    caresMost: row.caresMost,
    description: row.description,
    ownerId: row.ownerId,
    state: row.state,
    budget: row.budget,
    criteria: criteria.map(criterionDto),
    taskIds: goalTaskRows(db, row.id).map((t) => t.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A goal's tasks in board order, cancelled ones included: the digest lists them apart. */
function goalTaskRows(db: DbReader, goalId: GoalId) {
  return db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.goalId, goalId))
    .orderBy(asc(schema.tasks.boardOrder), asc(schema.tasks.id))
    .all();
}

export function getGoal(db: DbReader, id: GoalId): GoalDto {
  const row = db.select().from(schema.goals).where(eq(schema.goals.id, id)).get();
  if (!row) throw new NotFoundError('goal', id);
  return toGoalDto(db, row);
}

/** The project's goals, oldest first. */
export function listGoals(db: DbReader, projectId: ProjectId): GoalDto[] {
  return db
    .select()
    .from(schema.goals)
    .where(eq(schema.goals.projectId, projectId))
    .orderBy(asc(schema.goals.createdAt), asc(schema.goals.id))
    .all()
    .map((row) => toGoalDto(db, row));
}

/** A goal's tasks in board order, cancelled ones included (progress lists them apart, §8). */
export function listGoalTasks(db: DbReader, goalId: GoalId): TaskDto[] {
  getGoal(db, goalId);
  return goalTaskRows(db, goalId).map(({ id }) => getTask(db, id));
}

/** When the person last opened the goal in Factory; null before the first time. */
export function lastGoalView(db: DbReader, goalId: GoalId, personId: PersonId): string | null {
  const row = db
    .select({ openedAt: schema.goalViews.openedAt })
    .from(schema.goalViews)
    .where(and(eq(schema.goalViews.goalId, goalId), eq(schema.goalViews.personId, personId)))
    .get();
  return row?.openedAt ?? null;
}

/**
 * A visit lasts while the goal is opened again within this long of its last opening. A refetch or
 * a remount during it answers the window the visit began with; after a quiet spell the next
 * opening starts a new visit.
 */
export const VISIT_GAP_MS = 30 * 60_000;

/**
 * A visit also ends this long after it began, however often the goal is opened in between (every
 * row click opens it), so 'since you left' never reaches back past hours of viewing.
 */
export const VISIT_MAX_MS = 2 * 60 * 60_000;

/**
 * Marks the goal opened by the person now and answers where the Δ window starts: the mark before
 * this visit began (null on the first visit). An opening within `VISIT_GAP_MS` of the last one
 * continues its visit, so a refresh keeps the rows the builder was reading (§8), unless the visit
 * began more than `VISIT_MAX_MS` ago; otherwise the last mark closes and the window starts there.
 * `openedAt` always moves to now, which keeps the goal list's count of new items at zero after an
 * opening.
 */
export function markGoalViewed(
  ctx: WriteContext,
  goalId: GoalId,
  personId: PersonId,
): string | null {
  getGoal(ctx.tx, goalId);
  getPerson(ctx.tx, personId);
  const row = ctx.tx
    .select()
    .from(schema.goalViews)
    .where(and(eq(schema.goalViews.goalId, goalId), eq(schema.goalViews.personId, personId)))
    .get();
  const now = Date.parse(ctx.now);
  const continuing =
    row !== undefined &&
    now - Date.parse(row.openedAt) <= VISIT_GAP_MS &&
    now - Date.parse(row.visitStartedAt ?? row.openedAt) <= VISIT_MAX_MS;
  const since = row === undefined ? null : continuing ? row.visitSince : row.openedAt;
  const visitStartedAt = continuing ? (row.visitStartedAt ?? row.openedAt) : ctx.now;
  ctx.tx
    .insert(schema.goalViews)
    .values({ goalId, personId, openedAt: ctx.now, visitSince: since, visitStartedAt })
    .onConflictDoUpdate({
      target: [schema.goalViews.goalId, schema.goalViews.personId],
      set: { openedAt: ctx.now, visitSince: since, visitStartedAt },
    })
    .run();
  return since;
}
