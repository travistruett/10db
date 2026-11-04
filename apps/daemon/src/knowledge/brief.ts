import type { ProjectId } from '@10db/contracts';
import { listPrinciples, type DbReader } from '@10db/db';
import { CONTEXT_PACK_BUDGET_TOKENS, packKnowledge } from './pack';
import { renderRules } from './render';

/**
 * The standing rules a Plan conversation starts with (spec §9): the builder-wide and the project's
 * policies, then heuristics, packed and worded as a lane gets them. No area applies to a
 * conversation, so area principles stay out; the session finds them with `find_records`. Empty when
 * no rule applies.
 */
export function principlesBrief(db: DbReader, projectId: ProjectId): string {
  const pack = packKnowledge({
    areas: [],
    principles: listPrinciples(db, { projectId }),
    decisions: [],
    ranked: [],
    budgetTokens: CONTEXT_PACK_BUDGET_TOKENS,
  });
  const rules = renderRules(pack);
  if (rules.length === 0) return '';
  const omitted = pack.dropped.policies + pack.dropped.heuristics;
  return [
    "The builder's standing rules for this project. Follow the policies and prefer the heuristics; cite one by its id.",
    ...rules,
    ...(omitted > 0
      ? [`${String(omitted)} more exceeded the budget; call find_records for them.`]
      : []),
  ].join('\n');
}
