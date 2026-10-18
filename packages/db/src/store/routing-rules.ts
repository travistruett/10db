import {
  EventType,
  InvalidError,
  mintId,
  RoutingRulesInput,
  type ProjectId,
  type RoutingRuleDto,
} from '@10db/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

export function listRoutingRules(db: DbReader, projectId: ProjectId): RoutingRuleDto[] {
  return db
    .select()
    .from(schema.routingRules)
    .where(eq(schema.routingRules.projectId, projectId))
    .orderBy(asc(schema.routingRules.category), asc(schema.routingRules.area))
    .all();
}

/** Replaces the project's rule list; an area must be one of the project's areas. */
export function setRoutingRules(
  ctx: WriteContext,
  projectId: ProjectId,
  input: RoutingRulesInput,
): RoutingRuleDto[] {
  const { rules } = RoutingRulesInput.parse(input);
  const areas = new Set(getProject(ctx.tx, projectId).areas.map((a) => a.name));
  for (const rule of rules)
    if (rule.area !== null && !areas.has(rule.area))
      throw new InvalidError(`The project has no area "${rule.area}"`);
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
