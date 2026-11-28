import {
  BuilderOwns,
  DECISION_RULE_NAMES,
  DecisionRule,
  InboxKind,
  ProjectId,
  Urgency,
  type InboxAnswer,
  type InboxItemDto,
} from '@10db/contracts';
import {
  clearRuleMarks,
  getProject,
  RULE_UNDOS_TO_ASK,
  RULE_WINDOW_DAYS,
  RuleMark,
  setRuleAsking,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import { BY_ANSWER, CardTier, decidedByBuilder } from './card-tier';
import { flagCard } from './service';

/** The `detail` key of a rule-asks card: the project and the rule it switched. */
export const RULE_ASKS_DETAIL = 'ruleAsks';

export const RuleAsksChoice = { Keep: 'Keep Asking', Decide: 'Let 10db Decide Again' } as const;
export type RuleAsksChoice = (typeof RuleAsksChoice)[keyof typeof RuleAsksChoice];

const RuleAsksDetail = z.object({ projectId: ProjectId, rule: z.enum(DecisionRule) });

/** One card for each project and rule: a rule asks once, until the builder lets it decide again. */
export const ruleAsksFoldKey = (projectId: ProjectId, rule: DecisionRule): string =>
  `rule-asks:${projectId}:${rule}`;

/** An undone decision, as the card lists it. */
export interface UndoneLine {
  readonly line: string;
  readonly at: string;
}

/**
 * Raises the card that says a rule now asks, in the write that switched it: the rule decided alone until
 * the builder undid it again, so its next decision is a card.
 */
export function raiseRuleAsksCard(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly rule: DecisionRule;
    readonly undone: readonly UndoneLine[];
  },
): void {
  const { projectId, rule } = input;
  const project = getProject(ctx.tx, projectId);
  const lines = input.undone.map(({ line, at }) => `- ${line} (${at.slice(0, 10)})`);
  flagCard(ctx, {
    projectId,
    workstreamId: null,
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.Guardrails),
    title: `${DECISION_RULE_NAMES[rule]} now asks you in ${project.name}`,
    body: [
      `You undid this rule's decision twice in ${String(RULE_WINDOW_DAYS)} days, so its next one is a card.`,
      ...lines,
    ].join('\n'),
    options: [
      {
        label: RuleAsksChoice.Keep,
        description: "The rule's next decision is a card for you in this project",
      },
      {
        label: RuleAsksChoice.Decide,
        description: `The rule decides alone again here; your next ${String(RULE_UNDOS_TO_ASK)} undos count afresh`,
      },
    ],
    detail: { [RULE_ASKS_DETAIL]: { projectId, rule } },
    foldKey: ruleAsksFoldKey(projectId, rule),
  });
}

/**
 * Acts on a rule-asks card's answer in the answer's own write. Let 10db Decide Again sets the rule back to
 * deciding and forgets its undos; Keep Asking changes nothing. Any other card and answer is left alone.
 */
export function applyRuleAsksAnswer(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  if (item.kind !== InboxKind.Flag || answer.choice !== RuleAsksChoice.Decide) return;
  // The detail is JSON read back from the database: a boundary, so parse it.
  const parsed = RuleAsksDetail.safeParse(item.detail?.[RULE_ASKS_DETAIL]);
  if (!parsed.success) return;
  const { projectId, rule } = parsed.data;
  setRuleAsking(ctx, projectId, rule, false);
  clearRuleMarks(ctx, projectId, rule, RuleMark.Undone);
}
