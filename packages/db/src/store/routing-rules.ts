import {
  EventType,
  InboxKind,
  InvalidError,
  TaskStatus,
  mintId,
  type QuestionCategory,
  RoutingRulesInput,
  type ProjectId,
  type RoutingRuleDto,
  type TaskId,
} from '@10db/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { BUILDER_HANDLE, listPeople } from './team';

export function listRoutingRules(db: DbReader, projectId: ProjectId): RoutingRuleDto[] {
  return db
    .select()
    .from(schema.routingRules)
    .where(eq(schema.routingRules.projectId, projectId))
    .orderBy(asc(schema.routingRules.id))
    .all();
}

/**
 * Replaces the project's whole rule list at every scope. An area must be one of the project's areas,
 * and a goal or task must belong to the project. Ids are time-ordered, so listing by id keeps the order
 * the list gave, which is the routing order of a tie.
 */
export function setRoutingRules(
  ctx: WriteContext,
  projectId: ProjectId,
  input: RoutingRulesInput,
): RoutingRuleDto[] {
  const { rules } = RoutingRulesInput.parse(input);
  const areas = new Set(getProject(ctx.tx, projectId).areas.map((a) => a.name));
  for (const rule of rules) {
    if (rule.area !== null && !areas.has(rule.area))
      throw new InvalidError(`The project has no area "${rule.area}"`);
    if (rule.goalId !== null) {
      const goal = ctx.tx
        .select({ projectId: schema.goals.projectId })
        .from(schema.goals)
        .where(eq(schema.goals.id, rule.goalId))
        .get();
      if (goal?.projectId !== projectId)
        throw new InvalidError(`The project has no goal ${rule.goalId}`);
    }
    if (rule.taskId !== null) {
      const task = ctx.tx
        .select({ projectId: schema.tasks.projectId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, rule.taskId))
        .get();
      if (task?.projectId !== projectId)
        throw new InvalidError(`The project has no task ${rule.taskId}`);
    }
  }
  const personIds = [...new Set(rules.map((r) => r.personId))];
  if (personIds.length > 0) {
    const found = new Set(
      ctx.tx
        .select({ id: schema.people.id })
        .from(schema.people)
        .where(inArray(schema.people.id, personIds))
        .all()
        .map((p) => p.id),
    );
    const missing = personIds.find((id) => !found.has(id));
    if (missing !== undefined) throw new InvalidError(`No person ${missing}`);
  }
  ctx.tx.delete(schema.routingRules).where(eq(schema.routingRules.projectId, projectId)).run();
  if (rules.length > 0)
    ctx.tx
      .insert(schema.routingRules)
      .values(
        rules.map((r) => ({
          id: mintId('RoutingRule'),
          projectId,
          ...r,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })),
      )
      .run();
  ctx.emit({ type: EventType.RoutingRulesSaved, entityType: 'routing_rules', entityId: projectId });
  return listRoutingRules(ctx.tx, projectId);
}

/** Where in the rules a card's recipients came from. */
export type RouteTier = 'task' | 'goal_area' | 'goal' | 'project_area' | 'triage' | 'builder';

export interface AssigneesInput {
  readonly projectId: ProjectId;
  readonly kind: InboxKind;
  readonly category: QuestionCategory;
  readonly topic: string | null;
  readonly taskIds: readonly TaskId[];
  /** The card is a Workbench pass page's question: the builder is working through that pass live. */
  readonly passPage: boolean;
}

export interface AssigneesResult {
  readonly handles: string[];
  readonly tier: RouteTier;
  /** Said on the card when a tie was too big for a group DM; null otherwise. */
  readonly note: string | null;
}

/** The most people a Slack group DM holds, besides the bot. */
const MAX_RECIPIENTS = 8;

const toBuilder = (note: string | null = null): AssigneesResult => ({
  handles: [BUILDER_HANDLE],
  tier: 'builder',
  note,
});

/**
 * The handles a card goes to, in routing order, and the tier that chose them. Only question cards are
 * routed, and a card with no task, one asked by a pass page, or one whose tasks resolve to different
 * people goes to the builder. For each task the first tier that matches wins, and every route at that
 * tier counts (a tie): the task's own routes, its goal's area routes, its goal's category routes, then
 * the project's area routes. With none, a project that has category or topic routes leaves the card to
 * triage, and `handles` is what the lane's own tags give: the topic route's people, else the category's.
 */
export function assigneesFor(db: DbReader, input: AssigneesInput): AssigneesResult {
  if (input.kind !== InboxKind.Question || input.passPage || input.taskIds.length === 0)
    return toBuilder();
  const rules = listRoutingRules(db, input.projectId);
  const handleOf = new Map(listPeople(db).map((p) => [p.id, p.handle]));
  const handlesOf = (matched: readonly RoutingRuleDto[]): string[] => [
    ...new Set(matched.flatMap((r) => handleOf.get(r.personId) ?? [])),
  ];
  const cancelled = new Set(
    db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.id, [...input.taskIds]),
          eq(schema.tasks.status, TaskStatus.Cancelled),
        ),
      )
      .all()
      .map((t) => t.id),
  );
  const category = rules.filter((r) => r.category === input.category);
  const resolved = [...new Set(input.taskIds)].map((taskId) => {
    const task = db
      .select({ goalId: schema.tasks.goalId, areas: schema.tasks.areas })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    const areas = task?.areas ?? [];
    const goalId = task?.goalId ?? null;
    const inAreas = (r: RoutingRuleDto): boolean => r.area !== null && areas.includes(r.area);
    const tiers: [RouteTier, RoutingRuleDto[]][] = [
      ['task', cancelled.has(taskId) ? [] : category.filter((r) => r.taskId === taskId)],
      [
        'goal_area',
        goalId === null ? [] : category.filter((r) => r.goalId === goalId && inAreas(r)),
      ],
      [
        'goal',
        goalId === null ? [] : category.filter((r) => r.goalId === goalId && r.area === null),
      ],
      [
        'project_area',
        category.filter((r) => r.goalId === null && r.taskId === null && inAreas(r)),
      ],
    ];
    const hit = tiers.find(([, matched]) => matched.length > 0);
    return hit ? { tier: hit[0], matched: hit[1] } : null;
  });
  const projectScope = rules.filter((r) => r.goalId === null && r.taskId === null);
  const triage = (): AssigneesResult => {
    const topicRoute =
      input.topic === null ? [] : projectScope.filter((r) => r.topic === input.topic);
    const byCategory = projectScope.filter((r) => r.category === input.category && r.area === null);
    const handles = handlesOf(topicRoute.length > 0 ? topicRoute : byCategory);
    return { handles: handles.length > 0 ? handles : [BUILDER_HANDLE], tier: 'triage', note: null };
  };
  const perTask = resolved.map((r): { tier: RouteTier; handles: string[] } => {
    if (r) return { tier: r.tier, handles: handlesOf(r.matched) };
    const hasTriageRoutes = projectScope.some(
      (x) => x.topic !== null || (x.category !== null && x.area === null),
    );
    return hasTriageRoutes ? triage() : { tier: 'builder', handles: [BUILDER_HANDLE] };
  });
  const first = perTask[0];
  if (!first) return toBuilder();
  const same = perTask.every(
    (t) =>
      t.handles.length === first.handles.length &&
      [...t.handles].sort().join('\u0000') === [...first.handles].sort().join('\u0000'),
  );
  if (!same) return toBuilder();
  if (first.handles.length > MAX_RECIPIENTS)
    return toBuilder(
      `${String(first.handles.length)} people answer ${input.category} questions here, more than a Slack group DM holds. Use Ask Someone to pick.`,
    );
  return { handles: first.handles, tier: first.tier, note: null };
}
