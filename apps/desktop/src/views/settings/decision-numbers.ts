import {
  JudgeOutcome,
  SHADOW_MIN_SCORED,
  type DecisionModelDto,
  type DecisionStatsDto,
  type DecisionStatsListDto,
  type JudgeCallDto,
  type JudgeDecision,
  type ShadowAgreementDto,
} from '@10db/contracts';
import { DECISIONS, DecisionMode } from './decision-catalogue';

export const DecisionStatus = {
  Acting: 'Acting',
  Shadow: 'Shadow',
  Off: 'Off',
  AllOff: 'Off (all decisions)',
} as const;
export type DecisionStatus = (typeof DecisionStatus)[keyof typeof DecisionStatus];

/** The master switch beats a decision's own: while it is off every row reads the same. */
export function decisionStatus(
  mode: DecisionMode,
  decisionOn: boolean,
  allOn: boolean,
): DecisionStatus {
  if (!allOn) return DecisionStatus.AllOff;
  if (!decisionOn) return DecisionStatus.Off;
  return mode === DecisionMode.Shadow ? DecisionStatus.Shadow : DecisionStatus.Acting;
}

/** The decision's stats: its entry, a zero entry when the list loaded without it (no calls), undefined while unread. */
export function statsFor(
  list: DecisionStatsListDto | undefined,
  decision: JudgeDecision,
): DecisionStatsDto | undefined {
  if (list === undefined) return undefined;
  return (
    list.decisions.find((s) => s.decision === decision) ?? {
      decision,
      calls: 0,
      acted: 0,
      belowFloor: 0,
      shadow: 0,
      stopped: 0,
      fallbacks: { off: 0, no_key: 0, timeout: 0, error: 0 },
      costUsd: 0,
      medianLatencyMs: null,
      answers: [],
    }
  );
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 3,
});

/** Three significant figures, never in exponent form: $0.042, $0.02, $0.192, $0.0000009. */
export function formatDecisionUsd(usd: number): string {
  return USD.format(usd);
}

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

export function lastThirtyDays(
  stats: DecisionStatsDto | undefined,
  mode: DecisionMode,
  agreement: ShadowAgreementDto | undefined,
): string {
  if (stats === undefined) return '—';
  const calls = stats.calls === 0 ? 'No calls' : plural(stats.calls, 'call');
  if (mode === DecisionMode.Shadow) {
    // Without the agreement read, nothing is known about how many are scored.
    if (agreement === undefined) return `${calls} · —`;
    const progress =
      agreement.scored >= SHADOW_MIN_SCORED
        ? `${String(agreement.agreed)} of ${String(agreement.scored)} agreed`
        : `${String(agreement.scored)} of ${String(SHADOW_MIN_SCORED)} scored`;
    return `${calls} · ${progress}`;
  }
  if (stats.calls === 0) return calls;
  return `${calls} · ${String(stats.acted)} acted · ${formatDecisionUsd(stats.costUsd)}`;
}

export interface ThresholdPreview {
  readonly acted: number;
  readonly total: number;
  readonly otherModels: readonly string[];
}

/** How many of the last answers a floor would have acted on; an answer equal to the floor acts. */
export function thresholdPreview(
  answers: DecisionStatsDto['answers'],
  floor: number,
  model: string,
): ThresholdPreview {
  const otherModels = [...new Set(answers.map((a) => a.model).filter((m) => m !== model))];
  return {
    acted: answers.filter((a) => a.confidence >= floor).length,
    total: answers.length,
    otherModels,
  };
}

export function previewText(
  percent: number,
  preview: ThresholdPreview,
  mode: DecisionMode = DecisionMode.Acting,
): string {
  if (preview.total === 0) return 'No answers in the last 30 days to try it against.';
  // A shadow decision acts on nothing: its answers only count as sure.
  const did = mode === DecisionMode.Shadow ? 'counted as sure' : 'acted on';
  const base = `At ${String(percent)}%, 10db would have ${did} ${String(preview.acted)} of your last ${String(preview.total)} answers.`;
  if (preview.otherModels.length === 0) return base;
  return `${base} Some were answered by ${preview.otherModels.join(', ')}, not the model picked now.`;
}

/** What 10db did, in the builder's words, for the outcomes that fall back to today's rule. */
const FALLBACK_PREFIX = {
  [JudgeOutcome.BelowFloor]: 'Not sure enough',
  [JudgeOutcome.FallbackOff]: 'Decisions were off',
  [JudgeOutcome.FallbackNoKey]: 'No key',
  [JudgeOutcome.FallbackTimeout]: 'Timed out',
  [JudgeOutcome.FallbackError]: 'The call failed',
} as const;

/** The answer and the outcome together: "acted" means different things per decision. */
export function outcomeText(call: Pick<JudgeCallDto, 'decision' | 'outcome' | 'answer'>): string {
  switch (call.outcome) {
    case JudgeOutcome.Acted:
      if (call.answer === 'skip') return 'Skipped the review';
      if (call.answer === 'review') return 'Ran the review';
      return 'Followed the answer';
    case JudgeOutcome.Stopped:
      return 'Stopped before it answered';
    case JudgeOutcome.Shadow:
      return 'Logged in shadow; nothing shown';
    case JudgeOutcome.BelowFloor:
    case JudgeOutcome.FallbackOff:
    case JudgeOutcome.FallbackNoKey:
    case JudgeOutcome.FallbackTimeout:
    case JudgeOutcome.FallbackError:
      return `${FALLBACK_PREFIX[call.outcome]}; ${DECISIONS[call.decision].fellBack}`;
  }
}

export function answerText(call: Pick<JudgeCallDto, 'answer' | 'confidence'>): string {
  if (call.answer === null) return 'no answer';
  if (call.confidence === null) return call.answer;
  return `${call.answer} (${String(Math.round(call.confidence * 100))}%)`;
}

/** The model's name from the list, else its id without the maker. */
export function modelName(id: string, models: readonly DecisionModelDto[] | undefined): string {
  return models?.find((m) => m.id === id)?.name ?? id.slice(id.indexOf('/') + 1);
}
