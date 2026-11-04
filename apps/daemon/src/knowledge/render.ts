import type { KnowledgeScope } from '@10db/contracts';

interface Cited {
  readonly id: string;
  readonly scope: KnowledgeScope;
  readonly area: string | null;
}

export interface RenderedPrinciple extends Cited {
  readonly topicKey: string;
  readonly statement: string;
}

export interface RenderedDecision extends Cited {
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
}

/** Agent-written text is data: one line, so a statement can't start a line of the prompt's own. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Where a record applies, as an agent cites it: `you`, `project` or `area:<name>`. */
const scopeLabel = (r: Cited): string => (r.scope === 'area' ? `area:${r.area ?? ''}` : r.scope);

const cite = (r: Cited): string => `{${r.id}, ${scopeLabel(r)}}`;

/** One policy or heuristic as a bullet an agent can cite by its key and id. */
export const principleBullet = (p: RenderedPrinciple): string =>
  `- [${oneLine(p.topicKey)}] ${oneLine(p.statement)} ${cite(p)}`;

/** One decision as a bullet an agent can cite by its id. */
export const decisionBullet = (d: RenderedDecision): string =>
  `- ${oneLine(d.question)} -> ${oneLine(d.choice)} (${oneLine(d.rationale)}) ${cite(d)}`;

/**
 * The policies, then the heuristics, as the text a session reads (spec §9). The briefing and the Plan
 * sessions' principles brief both use it, so every session reads a rule the same way.
 */
export function renderRules(rules: {
  readonly policies: readonly RenderedPrinciple[];
  readonly heuristics: readonly RenderedPrinciple[];
}): string[] {
  return [
    ...(rules.policies.length > 0
      ? ['Policies (you must follow these):', ...rules.policies.map(principleBullet)]
      : []),
    ...(rules.heuristics.length > 0
      ? ['Heuristics (prefer these):', ...rules.heuristics.map(principleBullet)]
      : []),
  ];
}

/** The decisions that apply to the task, as the text a session reads. */
export function renderDecisions(decisions: readonly RenderedDecision[]): string[] {
  return decisions.length > 0 ? ['Recorded decisions:', ...decisions.map(decisionBullet)] : [];
}
