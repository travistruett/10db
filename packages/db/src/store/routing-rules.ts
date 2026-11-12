import {
  EventType,
  InvalidError,
  mintId,
  type QuestionCategory,
  RoutingRulesInput,
  type ProjectId,
  type RoutingRuleDto,
} from '@10db/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { BUILDER_HANDLE, getPerson } from './team';

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

/** The handle a card goes to: an area rule beats a category rule, and the builder gets the rest (spec §7). */
export function assigneeFor(
  db: DbReader,
  projectId: ProjectId,
  category: QuestionCategory,
  areas: readonly string[],
): string {
  const rules = listRoutingRules(db, projectId).filter(
    (r) => r.category === category && r.goalId === null && r.taskId === null,
  );
  const rule =
    rules.find((r) => r.area !== null && areas.includes(r.area)) ??
    rules.find((r) => r.area === null);
  return rule ? getPerson(db, rule.personId).handle : BUILDER_HANDLE;
}
