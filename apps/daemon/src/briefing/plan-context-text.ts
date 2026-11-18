import { McpToolName, type PlanContext, type PlanItemDropped } from '@10db/contracts';
import { planItemLine } from '../plan-record';

/**
 * The Plan block of a lane's brief: where it comes from, the goal, the task's section and the shared
 * sections verbatim, then the cited items by group and what was left out. An empty group is left out.
 */
export function renderPlanContext(plan: PlanContext): string[] {
  const group = (heading: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [heading, ...lines];
  return [
    ...header(plan),
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
    ...notIncludedLine(plan),
  ];
}

const notIncludedLine = (plan: PlanContext): string[] =>
  plan.notIncluded.length === 0
    ? []
    : [`Not included (call ${McpToolName.GetPlanEntry}): ${plan.notIncluded.join(', ')}`];

const header = (plan: PlanContext): string[] => [
  `Plan context (from Plan "${plan.title}", revision ${String(plan.document.revision)} of ${plan.document.title}):`,
  ...(plan.goal === null ? [] : [`Goal: ${plan.goal.objective} — why: ${plan.goal.why}`]),
];

/** A cited entry's key, and why it no longer stands when it doesn't. */
const keyOf = (item: { readonly key: string; readonly dropped: PlanItemDropped | null }): string =>
  item.dropped === null ? item.key : `${item.key} (${item.dropped})`;

/**
 * The Plan block of an indexed brief: the header and goal, then the section, the shared sections and
 * each cited entry by its ref or key only, with the tools that read them. No section text, choice,
 * rationale or quote is pasted: the lane reads what it needs.
 */
export function renderPlanIndex(plan: PlanContext): string[] {
  const entries = (heading: string, keys: readonly string[]): string[] =>
    keys.length === 0
      ? []
      : [`${heading} (read each with ${McpToolName.GetPlanEntry}): ${keys.join(', ')}`];
  return [
    ...header(plan),
    `Your section: ${plan.section.ref}. Read it with ${McpToolName.GetPlanSection} before you start.`,
    ...(plan.shared.length === 0
      ? []
      : [
          `Shared sections (read each with ${McpToolName.GetPlanSection}): ${plan.shared.map((s) => s.ref).join(', ')}`,
        ]),
    ...entries('Decisions you rely on', plan.decisions.map(keyOf)),
    ...entries('Names', plan.names.map(keyOf)),
    ...entries('Facts', plan.facts.map(keyOf)),
    ...entries(
      'Open findings on this section',
      plan.findings.map((f) => `${f.key} (${f.severity})`),
    ),
    ...entries('Intent', plan.intent.map(keyOf)),
    ...notIncludedLine(plan),
    `Search the plan with ${McpToolName.FindPlanEntries}.`,
  ];
}
