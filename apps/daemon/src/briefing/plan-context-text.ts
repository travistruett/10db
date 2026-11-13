import type { PlanContext } from '@10db/contracts';
import { planItemLine } from '../plan-record';

/**
 * The Plan block of a lane's brief: where it comes from, the goal, the task's section and the shared
 * sections verbatim, then the cited items by group and what was left out. An empty group is left out.
 */
export function renderPlanContext(plan: PlanContext): string[] {
  const group = (heading: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [heading, ...lines];
  return [
    `Plan context (from Plan "${plan.title}", revision ${String(plan.document.revision)} of ${plan.document.title}):`,
    ...(plan.goal === null ? [] : [`Goal: ${plan.goal.objective} — why: ${plan.goal.why}`]),
    `Your section (${plan.section.ref}):`,
    plan.section.text,
    ...plan.shared.flatMap((s) => [`Shared section (${s.ref}):`, s.text]),
    ...group(
      'Decisions you rely on:',
      plan.decisions.map((item) => planItemLine({ group: 'decision', item })),
    ),
    ...group(
      'Names:',
      plan.names.map((item) => planItemLine({ group: 'name', item })),
    ),
    ...group(
      'Facts:',
      plan.facts.map((item) => planItemLine({ group: 'fact', item })),
    ),
    ...group(
      'Open findings on this section:',
      plan.findings.map((item) => planItemLine({ group: 'finding', item })),
    ),
    ...group(
      'Intent:',
      plan.intent.map((item) => planItemLine({ group: 'intent', item })),
    ),
    ...(plan.notIncluded.length === 0
      ? []
      : [`Not included (call get_plan_entry): ${plan.notIncluded.join(', ')}`]),
  ];
}
