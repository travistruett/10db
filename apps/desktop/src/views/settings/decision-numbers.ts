import {
  JudgeDecision,
  JudgeOutcome,
  SHADOW_MIN_SCORED,
  type DecisionModelDto,
  type DecisionStatsDto,
  type DecisionStatsListDto,
  type JudgeCallDto,
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
      overridden: 0,
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

/** A decision's last 30 days as table cells: its calls, what came of them, and what they cost. */
export interface ThirtyDayCells {
  readonly calls: string;
  /** How many it acted on, or for a shadow decision how far its scoring has got. */
  readonly outcome: string;
  readonly cost: string;
}

export function lastThirtyDays(
  stats: DecisionStatsDto | undefined,
  mode: DecisionMode,
  agreement: ShadowAgreementDto | undefined,
): ThirtyDayCells {
  const none = { calls: '—', outcome: '—', cost: '—' };
  if (stats === undefined) return none;
  const calls = String(stats.calls);
  const cost = stats.calls === 0 ? '—' : formatDecisionUsd(stats.costUsd);
  if (mode === DecisionMode.Shadow) {
    // Without the agreement read, nothing is known about how many are scored.
    if (agreement === undefined) return { calls, outcome: '—', cost };
    const outcome =
      agreement.scored >= SHADOW_MIN_SCORED
        ? `${String(agreement.agreed)} of ${String(agreement.scored)} agreed`
        : `${String(agreement.scored)} of ${String(SHADOW_MIN_SCORED)} scored`;
    return { calls, outcome, cost };
  }
  return { calls, outcome: stats.calls === 0 ? '—' : `${String(stats.acted)} acted`, cost };
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
  [JudgeOutcome.BelowFloor]: 'Not Sure Enough',
  [JudgeOutcome.FallbackOff]: 'Decisions Were Off',
  [JudgeOutcome.FallbackNoKey]: 'No Key',
  [JudgeOutcome.FallbackTimeout]: 'Timed Out',
  [JudgeOutcome.FallbackError]: 'The Call Failed',
} as const;

/** The answer and the outcome together: "acted" means different things per decision. */
export function outcomeText(
  call: Pick<JudgeCallDto, 'decision' | 'outcome' | 'answer' | 'model' | 'precedentId'>,
): string {
  if (call.decision === JudgeDecision.CrossesLimit) {
    const said = limitOutcomeText(call);
    if (said !== null) return said;
  }
  if (call.decision === JudgeDecision.CrossesLimitSecond) {
    const said = secondOpinionText(call);
    if (said !== null) return said;
  }
  switch (call.outcome) {
    case JudgeOutcome.Acted:
      if (call.answer === 'skip') return 'Skipped the review';
      if (call.answer === 'review') return 'Ran the review';
      return 'Followed the answer';
    case JudgeOutcome.Stopped:
      return 'Stopped before it answered';
    case JudgeOutcome.Shadow:
      return 'Logged in shadow; nothing shown';
    case JudgeOutcome.Overridden:
      return 'Overridden by you';
    case JudgeOutcome.BelowFloor:
    case JudgeOutcome.FallbackOff:
    case JudgeOutcome.FallbackNoKey:
    case JudgeOutcome.FallbackTimeout:
    case JudgeOutcome.FallbackError:
      return `${FALLBACK_PREFIX[call.outcome]}; ${DECISIONS[call.decision].fellBack}`;
  }
}

/** The model a logged auto mode denial names, which 10db never asks. */
const AUTO_MODE_MODEL = 'claude-code-auto-mode';

/** A limits call's outcome where it reads differently from the others; null where it doesn't. */
function limitOutcomeText(
  call: Pick<JudgeCallDto, 'outcome' | 'answer' | 'model' | 'precedentId'>,
): string | null {
  if (call.model === AUTO_MODE_MODEL) return 'Auto mode stopped it';
  if (call.precedentId !== null) return 'Allowed as routine';
  if (call.outcome === JudgeOutcome.BelowFloor)
    return 'Between yes and no; asked the second opinion';
  if (call.outcome === JudgeOutcome.Acted)
    return call.answer === 'allow' ? 'Allowed' : 'Stopped at a Limit';
  return null;
}

/** A second opinion's outcome: it settles the call, or neither judge could and it was stopped. */
function secondOpinionText(call: Pick<JudgeCallDto, 'outcome' | 'answer'>): string | null {
  if (call.outcome === JudgeOutcome.BelowFloor)
    return "Couldn't settle it either; stopped the call";
  if (call.outcome === JudgeOutcome.Acted)
    return call.answer === 'allow' ? 'Allowed' : 'Stopped at a Limit';
  return null;
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
