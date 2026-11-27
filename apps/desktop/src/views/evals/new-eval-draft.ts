import {
  EvalBarChoice,
  type EvalCaseVerdict,
  EvalCheckKind,
  EvalPick,
  MAX_NEW_EVAL_CASES,
  type NewEvalBody,
  type NewEvalOrigin,
} from '@10db/contracts';

/** What the form opens with, from where New Eval was pressed. */
export interface NewEvalPrefill {
  /** A short name for the behavior; it ends in the task's title. */
  readonly behavior?: string;
  /** The one sentence on what it should do well, when the caller has one. */
  readonly goal?: string;
  readonly decision?: string;
  readonly evidence?: string;
  readonly oracle?: string;
  readonly coverageAndBar?: string;
  /** Model ids, comma separated. */
  readonly models?: string;
  readonly where?: readonly string[];
  readonly origin: NewEvalOrigin;
}

/** The longest behavior the task's title takes (`NewEvalRequest`). */
export const BEHAVIOR_MAX = 150;
/** The longest sentence the wizard files or asks a model to tighten. */
export const GOAL_MAX = 600;
/** Examples a build needs before the next step opens; the helper asks for more. */
export const MIN_CASES = 3;

/** One example row. `id` keys the list only; a row with no mark yet is `verdict: null`. */
export interface DraftCase {
  readonly id: number;
  readonly input: string;
  readonly verdict: EvalCaseVerdict | null;
  readonly reason: string;
}

export interface EvalDraft {
  readonly name: string;
  readonly goal: string;
  readonly cases: readonly DraftCase[];
  readonly check: EvalCheckKind | null;
  readonly checkRule: string;
  readonly bar: EvalBarChoice | null;
  readonly modelIds: readonly string[];
  /** Dollars as typed; empty is no cap. */
  readonly costCap: number | null;
  readonly pick: EvalPick;
}

/** The steps, in order; Review is the last. */
export const WizardStep = { Goal: 0, Examples: 1, Checking: 2, Models: 3, Review: 4 } as const;
export type WizardStep = (typeof WizardStep)[keyof typeof WizardStep];

/** One line cut to what a title takes, so a long objective or gap label still files. */
export const asBehavior = (text: string): string =>
  text
    .replaceAll(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, BEHAVIOR_MAX);

/** One line cut to what the wizard's sentence takes, so a long plan objective still files. */
export const asGoal = (text: string): string =>
  text
    .replaceAll(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, GOAL_MAX);

/** A model id typed or pasted as free text: one line, no backtick, which a brief can't carry. */
export const cleanModelId = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- the point is to drop control characters
  text.replaceAll(/[\u0000-\u001f\u007f`]/gu, '').trim();

export function initialDraft(prefill: NewEvalPrefill): EvalDraft {
  return {
    name: prefill.behavior ?? '',
    goal: prefill.goal ?? '',
    cases: [],
    check: null,
    checkRule: '',
    bar: null,
    modelIds: [
      ...new Set(
        (prefill.models ?? '')
          .split(',')
          .map(cleanModelId)
          .filter((m) => m !== ''),
      ),
    ],
    costCap: null,
    pick: EvalPick.Cheapest,
  };
}

/** The examples that are filled in and marked: the only ones that are filed. */
export const markedCases = (draft: EvalDraft): readonly DraftCase[] =>
  draft.cases.filter((c) => c.input.trim() !== '' && c.verdict !== null);

/**
 * Why a step's Next stays shut, in the words the footer shows; null when the step's minimum is met. The minimum
 * is only what the task cannot be written without.
 */
export function stepProblem(step: WizardStep, draft: EvalDraft): string | null {
  switch (step) {
    case WizardStep.Goal:
      if (draft.name.trim() === '') return 'Give it a short name.';
      if (draft.goal.trim() === '') return 'Say in a sentence what it should do well.';
      return null;
    case WizardStep.Examples: {
      const have = markedCases(draft).length;
      return have >= MIN_CASES
        ? null
        : `Add ${String(MIN_CASES - have)} more ${MIN_CASES - have === 1 ? 'example' : 'examples'} marked Good or Bad.`;
    }
    case WizardStep.Checking:
      if (draft.check === null) return 'Pick how a result is checked.';
      if (draft.bar === null) return 'Pick how often it must pass.';
      return null;
    case WizardStep.Models:
      return draft.modelIds.length === 0 ? 'Pick at least one model to try.' : null;
    case WizardStep.Review:
      return null;
  }
}

/** The first step whose minimum is not met, with why; null when every step is. */
export function firstProblem(draft: EvalDraft): { step: WizardStep; problem: string } | null {
  for (const step of [
    WizardStep.Goal,
    WizardStep.Examples,
    WizardStep.Checking,
    WizardStep.Models,
  ] as const) {
    const problem = stepProblem(step, draft);
    if (problem !== null) return { step, problem };
  }
  return null;
}

/** The request the daemon files; examples with no mark are left out, the rest of the draft goes as written. */
export function toRequest(draft: EvalDraft, prefill: NewEvalPrefill): NewEvalBody {
  return {
    behavior: asBehavior(draft.name),
    goal: draft.goal.trim(),
    decision: prefill.decision ?? '',
    evidence: prefill.evidence ?? '',
    oracle: prefill.oracle ?? '',
    coverageAndBar: prefill.coverageAndBar ?? '',
    models: '',
    execution: '',
    cases: markedCases(draft)
      .slice(0, MAX_NEW_EVAL_CASES)
      .flatMap((c) =>
        c.verdict === null
          ? []
          : [{ input: c.input.trim(), verdict: c.verdict, reason: c.reason.trim() }],
      ),
    check: draft.check,
    checkRule: draft.check === EvalCheckKind.Review ? '' : draft.checkRule.trim(),
    bar: draft.bar,
    modelIds: [...draft.modelIds],
    costCapUsd: draft.costCap,
    pick: draft.pick,
    where: [...(prefill.where ?? [])],
    origin: prefill.origin,
  };
}

export const CHECK_LABEL = {
  [EvalCheckKind.Rule]: 'A rule or test',
  [EvalCheckKind.Judge]: 'An AI judge',
  [EvalCheckKind.Review]: 'You look at the results',
} as const satisfies Record<EvalCheckKind, string>;

export const BAR_LABEL = {
  [EvalBarChoice.EveryTime]: 'Every time',
  [EvalBarChoice.NineInTen]: '9 in 10',
  [EvalBarChoice.SevenInTen]: '7 in 10',
} as const satisfies Record<EvalBarChoice, string>;

export const BAR_HELP = {
  [EvalBarChoice.EveryTime]: 'For what must never go wrong: safety, money, data.',
  [EvalBarChoice.NineInTen]: 'For what matters but can slip now and then.',
  [EvalBarChoice.SevenInTen]: 'For nice-to-have. Start here and raise it later.',
} as const satisfies Record<EvalBarChoice, string>;
