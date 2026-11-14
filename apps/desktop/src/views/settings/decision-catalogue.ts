import { JudgeDecision } from '@10db/contracts';

export const DecisionGroup = {
  Delivery: 'delivery',
  Sizing: 'sizing',
  Plan: 'plan',
  Stakeholders: 'stakeholders',
} as const;
export type DecisionGroup = (typeof DecisionGroup)[keyof typeof DecisionGroup];

export const DECISION_GROUP_ORDER: readonly DecisionGroup[] = [
  DecisionGroup.Delivery,
  DecisionGroup.Sizing,
  DecisionGroup.Plan,
  DecisionGroup.Stakeholders,
];

export const DECISION_GROUP_LABEL: Readonly<Record<DecisionGroup, string>> = {
  [DecisionGroup.Delivery]: 'Delivery',
  [DecisionGroup.Sizing]: 'Sizing',
  [DecisionGroup.Plan]: 'Plan',
  [DecisionGroup.Stakeholders]: 'Stakeholder questions',
};

/** Acting decisions change what 10db does; shadow ones only log answers to be scored. */
export const DecisionMode = { Acting: 'acting', Shadow: 'shadow' } as const;
export type DecisionMode = (typeof DecisionMode)[keyof typeof DecisionMode];

export interface DecisionEntry {
  readonly group: DecisionGroup;
  /** The row's name. */
  readonly label: string;
  /** What it asks, in plain words. */
  readonly asks: string;
  /** What 10db does on each answer at or above Sure enough. */
  readonly onAnswer: string;
  /** What 10db does below it, or when the call can't run (today's rule). */
  readonly whenUnsure: string;
  /** A short clause for Recent decisions: what happened in place of the answer. */
  readonly fellBack: string;
  readonly mode: DecisionMode;
  readonly note?: string;
}

const SHADOW_ON_ANSWER = 'Logged and scored against what you did next; nothing is shown yet.';
const SHADOW_WHEN_UNSURE = 'Nothing is logged as an answer.';
const SHADOW_NOTE =
  'Plan asks these only for a project with “Send brainstorm messages to fast models” on in its settings, and only logs the answers until each has 20 scored answers with 75% agreeing.';

export const DECISIONS: Readonly<Record<JudgeDecision, DecisionEntry>> = {
  [JudgeDecision.ReviewSize]: {
    group: DecisionGroup.Delivery,
    label: 'Skip review for small changes',
    asks: 'After a step’s checks pass: is this change small and well tested enough to skip the independent review?',
    onAnswer: 'Skip: the review is skipped. Review: it runs.',
    whenUnsure: 'The review runs.',
    fellBack: 'the review ran',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ShapeReady]: {
    group: DecisionGroup.Plan,
    label: 'Enough to propose',
    asks: 'After each message, until the first Propose: have you said enough to propose?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.ShapeRecord]: {
    group: DecisionGroup.Plan,
    label: 'Record as a decision?',
    asks: 'Does this message state a decision or principle worth recording?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.ShapeElsewhere]: {
    group: DecisionGroup.Plan,
    label: 'Question for someone else?',
    asks: 'Is this a question only someone else can answer?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.QuestionRoute]: {
    group: DecisionGroup.Stakeholders,
    label: 'Who a question goes to',
    asks: 'Which of the project’s routes a question an agent asked belongs to, or nobody.',
    onAnswer: 'A route: the card goes to its people. Nobody: it stays with you.',
    whenUnsure: 'It stays with you, with the top route’s people suggested under Ask Someone.',
    fellBack: 'you answer it',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ThreadAnswer]: {
    group: DecisionGroup.Stakeholders,
    label: 'Which option a conversation chose',
    asks: 'Once a Slack conversation settles: which option did it land on?',
    onAnswer: '10db posts "Sounds like B" in the thread for the asker to approve.',
    whenUnsure: '10db asks the asker which way it should go.',
    fellBack: '10db asked which way',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ReplyMatch]: {
    group: DecisionGroup.Stakeholders,
    label: 'Which question a reply answers',
    asks: 'A reply typed outside a thread, with several questions open: which one does it answer?',
    onAnswer: 'The reply joins that question’s conversation.',
    whenUnsure: '10db asks "Which one is this for?" with a numbered list.',
    fellBack: '10db asked which one',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ApprovalRead]: {
    group: DecisionGroup.Stakeholders,
    label: 'Whether a reply approves',
    asks: 'Does this reply approve the proposed answer?',
    onAnswer: 'Approves: the card is answered as the asker.',
    whenUnsure: 'A short list of words (yes, ok, sounds good…) is read instead.',
    fellBack: 'read with the word list',
    mode: DecisionMode.Acting,
  },
};

/** The groups that hold at least one of `configured`, in the page's order, each with its decisions. */
export function groupedDecisions(
  configured: readonly JudgeDecision[],
): readonly { readonly group: DecisionGroup; readonly decisions: readonly JudgeDecision[] }[] {
  const inOrder = Object.values(JudgeDecision).filter((d) => configured.includes(d));
  return DECISION_GROUP_ORDER.flatMap((group) => {
    const decisions = inOrder.filter((d) => DECISIONS[d].group === group);
    return decisions.length > 0 ? [{ group, decisions }] : [];
  });
}
