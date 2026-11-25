import { JudgeDecision } from '@10db/contracts';

export const DecisionGroup = {
  Delivery: 'delivery',
  Trust: 'trust',
  Sizing: 'sizing',
  Plan: 'plan',
  Stakeholders: 'stakeholders',
} as const;
export type DecisionGroup = (typeof DecisionGroup)[keyof typeof DecisionGroup];

export const DECISION_GROUP_ORDER: readonly DecisionGroup[] = [
  DecisionGroup.Delivery,
  DecisionGroup.Trust,
  DecisionGroup.Sizing,
  DecisionGroup.Plan,
  DecisionGroup.Stakeholders,
];

export const DECISION_GROUP_LABEL: Readonly<Record<DecisionGroup, string>> = {
  [DecisionGroup.Delivery]: 'Delivery',
  [DecisionGroup.Trust]: 'Trust',
  [DecisionGroup.Sizing]: 'Sizing',
  [DecisionGroup.Plan]: 'Plan',
  [DecisionGroup.Stakeholders]: 'Stakeholder Questions',
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
    label: 'Skip Review for Small Changes',
    asks: 'After a step’s checks pass: is this change small and well tested enough to skip the independent review?',
    onAnswer: 'Skip: the review is skipped. Review: it runs.',
    whenUnsure: 'The review runs.',
    fellBack: 'the review ran',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.Acceptance]: {
    group: DecisionGroup.Delivery,
    label: 'Acceptance',
    asks: 'After the final gate passes: is each acceptance criterion met by the change?',
    onAnswer: 'Met: the run goes on. Not met: it goes back to its build session.',
    whenUnsure: 'Counted as unclear.',
    fellBack: 'the run went on',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.AcceptanceSecond]: {
    group: DecisionGroup.Delivery,
    label: 'Acceptance, Second Opinion',
    asks: 'The same questions, asked of a stronger model, for a criterion the first call left unclear or not met.',
    onAnswer: 'It decides the criterion in place of the first call.',
    whenUnsure: 'Counted as unclear.',
    fellBack: 'the first call stood',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.TestValue]: {
    group: DecisionGroup.Delivery,
    label: 'Tests a Step Added',
    asks: 'For each test a step’s commits added: does it earn its place, or does it duplicate a test that exists, fold into one, or belong at a cheaper level?',
    onAnswer:
      'Keep: nothing happens. Anything else: a task with no review gets one follow-up task for each; with a review, the reviewer is told. It never blocks or fails a step.',
    whenUnsure: 'Counted as Keep.',
    fellBack: 'nothing was flagged',
    mode: DecisionMode.Acting,
    note: 'Each new test goes to the model through OpenRouter with its commit’s value card, the tests next to it and the names of the files it imports.',
  },
  [JudgeDecision.CrossesLimit]: {
    group: DecisionGroup.Trust,
    label: 'Limits',
    asks: 'Check calls against the four limits. On accounts without Claude Code’s auto mode (Codex, an older model), 10db’s judge asks one yes/no question per limit of each call.',
    onAnswer:
      'Every limit unlikely: the call runs. A limit likely: a card asks you, or a lane nobody watches skips the call. In between: the second opinion decides.',
    whenUnsure:
      'Sure enough is read both ways: a limit at or above it stops the call, and every limit below one minus it lets the call run.',
    fellBack: "10db's rules decided",
    mode: DecisionMode.Acting,
    note: 'Each call it checks goes to the model with the session’s setting, what you allowed or wrote on the run, and up to 12 000 characters of its input, and is kept in the recent decisions for 30 days. Off, 10db’s rules decide and say so.',
  },
  [JudgeDecision.CrossesLimitSecond]: {
    group: DecisionGroup.Trust,
    label: 'Second Opinion on Limits',
    asks: 'For a call the Limits judge left between yes and no: the same questions, asked of a stronger model.',
    onAnswer:
      'Every limit unlikely: the call runs. A limit likely: a card asks you, or a lane skips the call.',
    whenUnsure: 'Still in between: the call is stopped as a limit with no name.',
    fellBack: 'the call was stopped',
    mode: DecisionMode.Acting,
    note: 'It waits up to 20 seconds. Off, a call the Limits judge leaves in between is stopped, as before.',
  },
  [JudgeDecision.TaskRigor]: {
    group: DecisionGroup.Sizing,
    label: 'How Much Process a Task Needs',
    asks: 'How much process does this task need?',
    onAnswer: 'Sets the task’s rigor, unless it was set by you or an agent.',
    whenUnsure: 'The rules and the project’s default decide.',
    fellBack: 'the rules and the project’s default decided',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.TaskKinds]: {
    group: DecisionGroup.Sizing,
    label: 'What a Task Touches',
    asks: 'Does this task touch this kind of work? Asked once for each kind.',
    onAnswer: 'Yes: the task gets the kind, unless you took it off. No: it doesn’t.',
    whenUnsure: 'The rules decide.',
    fellBack: 'the rules decided',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ShapeReady]: {
    group: DecisionGroup.Plan,
    label: 'Enough to Propose',
    asks: 'After each message, until the first Propose: have you said enough to propose?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.ShapeRecord]: {
    group: DecisionGroup.Plan,
    label: 'Record as a Decision?',
    asks: 'Does this message state a decision or principle worth recording?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.ShapeElsewhere]: {
    group: DecisionGroup.Plan,
    label: 'Question for Someone Else?',
    asks: 'Is this a question only someone else can answer?',
    onAnswer: SHADOW_ON_ANSWER,
    whenUnsure: SHADOW_WHEN_UNSURE,
    fellBack: 'nothing shown',
    mode: DecisionMode.Shadow,
    note: SHADOW_NOTE,
  },
  [JudgeDecision.QuestionRoute]: {
    group: DecisionGroup.Stakeholders,
    label: 'Who a Question Goes To',
    asks: 'Which of the project’s routes a question an agent asked belongs to, or nobody.',
    onAnswer: 'A route: the card goes to its people. Nobody: it stays with you.',
    whenUnsure: 'It stays with you, with the top route’s people suggested under Ask Someone.',
    fellBack: 'you answer it',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ThreadAnswer]: {
    group: DecisionGroup.Stakeholders,
    label: 'Which Option a Conversation Chose',
    asks: 'Once a Slack conversation settles: which option did it land on?',
    onAnswer: '10db posts "Sounds like B" in the thread for the asker to approve.',
    whenUnsure: '10db asks the asker which way it should go.',
    fellBack: '10db asked which way',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ReplyMatch]: {
    group: DecisionGroup.Stakeholders,
    label: 'Which Question a Reply Answers',
    asks: 'A reply typed outside a thread, with several questions open: which one does it answer?',
    onAnswer: 'The reply joins that question’s conversation.',
    whenUnsure: '10db asks "Which one is this for?" with a numbered list.',
    fellBack: '10db asked which one',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ApprovalRead]: {
    group: DecisionGroup.Stakeholders,
    label: 'Whether a Reply Approves',
    asks: 'Does this reply approve the proposed answer?',
    onAnswer: 'Approves: the card is answered as the asker.',
    whenUnsure: 'A short list of words (yes, ok, sounds good…) is read instead.',
    fellBack: 'read with the word list',
    mode: DecisionMode.Acting,
  },
  [JudgeDecision.ReplyKind]: {
    group: DecisionGroup.Stakeholders,
    label: 'Reply Kind',
    asks: "Whether a stakeholder's reply answers the question, asks something 10db can explain, needs you, or is chatter",
    onAnswer:
      'Answers or chatter are handled; 10db tries to answer a question and passes it to you when it cannot or it needs your call.',
    whenUnsure:
      '10db still tries to answer a question first; anything else is read as an answer. With this switched off nothing is posted and questions come to you.',
    fellBack: 'sorted by rule, with 10db trying to answer questions first',
    mode: DecisionMode.Acting,
  },
};

/** The groups that hold at least one of `configured`, in the page's order, each with its decisions. */
export function groupedDecisions<D extends JudgeDecision>(
  configured: readonly D[],
): readonly { readonly group: DecisionGroup; readonly decisions: readonly D[] }[] {
  const order: readonly JudgeDecision[] = Object.values(JudgeDecision);
  const inOrder = [...configured].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return DECISION_GROUP_ORDER.flatMap((group) => {
    const decisions = inOrder.filter((d) => DECISIONS[d].group === group);
    return decisions.length > 0 ? [{ group, decisions }] : [];
  });
}
