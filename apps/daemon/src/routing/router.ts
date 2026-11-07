import {
  ROLE_SCORE,
  ScoreKind,
  type ModelProfileDto,
  type StepRole,
  type WorkstreamStep,
} from '@10db/contracts';
import type { Floor } from './floors';
import { automatic } from './pools';
import { ROLE_DEFAULT, strongerDefault } from './role-defaults';

export interface RouteInput {
  readonly role: StepRole;
  readonly need: number;
  readonly floor: Floor;
  readonly budgetCeiling: number | null;
  /** The profiles to choose among: the caller has already narrowed them to the account and the setting. */
  readonly profiles: readonly ModelProfileDto[];
  /**
   * What to do when none reaches the minimum score: refuse, or, for a pool a setting narrowed, take the one that
   * scores highest, since the builder asked for that pool.
   */
  readonly shortfall: 'refuse' | 'strongest';
}

export interface RouteChoice {
  readonly profile: ModelProfileDto;
  /** The score kind the choice was compared on; it is the step's own unless AA lacks it. */
  readonly score: ScoreKind;
  readonly reason: string;
  readonly overBudget: boolean;
}

/** No profile can run a step: measured ones exist but none reaches its minimum score. */
export class NoProfileError extends Error {
  override name = 'NoProfileError';
}

/** No profile has a cost and a score to compare on yet: there is nothing to route on. */
export class UnmeasuredError extends Error {
  override name = 'UnmeasuredError';
  /** The score kind routing tried to compare on. */
  readonly kind: ScoreKind;

  constructor(message: string, kind: ScoreKind) {
    super(message);
    this.kind = kind;
  }
}

const score = (p: ModelProfileDto, kind: ScoreKind): number | null => p.scores[kind];

function measured(profiles: readonly ModelProfileDto[], kind: ScoreKind): ModelProfileDto[] {
  return profiles.filter((p) => score(p, kind) !== null && p.costPerTaskUsd !== null);
}

const preference = (kind: ScoreKind) => (a: ModelProfileDto, b: ModelProfileDto) =>
  (a.costPerTaskUsd ?? 0) - (b.costPerTaskUsd ?? 0) ||
  (b.outputTokensPerSecond ?? 0) - (a.outputTokensPerSecond ?? 0) ||
  (score(a, kind) ?? 0) - (score(b, kind) ?? 0);

const withinCeiling = (p: ModelProfileDto, ceiling: number | null) =>
  ceiling === null || (p.costPerTaskUsd ?? 0) <= ceiling;
const dollars = (n: number) => `$${String(n)}`;

/**
 * The score a routing call compares on: the role's own, unless some costed profile
 * has an Intelligence score but lacks the role's own. Then every candidate is compared on
 * intelligence, so two indexes are never mixed. A profile with neither score can't be routed on
 * either way, so it doesn't trigger the fallback.
 */
function comparedOn(input: RouteInput, own: ScoreKind): ScoreKind {
  const gap = input.profiles.some(
    (p) =>
      p.costPerTaskUsd !== null &&
      score(p, ScoreKind.Intelligence) !== null &&
      score(p, own) === null,
  );
  return gap ? ScoreKind.Intelligence : own;
}

/** The cheapest measured profile at or above the step's need and floor, within the ceiling. */
export function route(input: RouteInput): RouteChoice {
  const own = ROLE_SCORE[input.role];
  const kind = comparedOn(input, own);
  const candidates = measured(input.profiles, kind);
  if (candidates.length === 0)
    throw new UnmeasuredError(`No profile has a ${kind} score yet`, kind);
  const minimum = Math.max(input.need, input.floor.minimum);
  const able = candidates.filter((p) => (score(p, kind) ?? 0) >= minimum).sort(preference(kind));
  const best = able.find((p) => withinCeiling(p, input.budgetCeiling)) ?? able[0];
  if (!best) {
    if (input.shortfall === 'refuse')
      throw new NoProfileError(`No profile reaches ${String(minimum)} ${kind}`);
    const strongest = [...candidates].sort(
      (a, b) => (score(b, kind) ?? 0) - (score(a, kind) ?? 0) || preference(kind)(a, b),
    )[0];
    if (!strongest) throw new NoProfileError(`No profile reaches ${String(minimum)} ${kind}`);
    return {
      profile: strongest,
      score: kind,
      overBudget: !withinCeiling(strongest, input.budgetCeiling),
      reason: `by score: none reaches ${String(minimum)} ${kind}, so the highest scoring`,
    };
  }
  const overBudget = !withinCeiling(best, input.budgetCeiling);
  const fellBack = kind === own ? '' : ` (AA gives no ${own} score; compared on ${kind})`;
  const floor =
    input.floor.why && input.floor.minimum > input.need ? ` (floor: ${input.floor.why})` : '';
  const budget =
    overBudget && input.budgetCeiling !== null
      ? `; over the budget ceiling of ${dollars(input.budgetCeiling)}`
      : '';
  return {
    profile: best,
    score: kind,
    overBudget,
    reason: `by score: cheapest profile at or above ${String(minimum)} ${kind}${fellBack}${floor}${budget}`,
  };
}

export interface EscalateInput {
  readonly budgetCeiling: number | null;
  readonly profiles: readonly ModelProfileDto[];
  /** Why the step is being retried, as a phrase: "the gate failed". */
  readonly why: string;
}

/** One rung up the role defaults' ladder, for a profile with nothing to compare on; the ceiling has no cost to apply. */
function climbRoleDefaults(
  step: WorkstreamStep,
  here: ModelProfileDto,
  input: EscalateInput,
): { readonly step: WorkstreamStep; readonly escalated: boolean } {
  const current = `${step.model}@${step.effort}`;
  const next = strongerDefault(here, input.profiles, ROLE_DEFAULT[step.role].tier);
  if (!next)
    return {
      step: { ...step, reason: `kept ${current} after ${input.why}: no stronger model offered` },
      escalated: false,
    };
  return {
    escalated: true,
    step: {
      ...step,
      profileId: next.id,
      model: next.model,
      effort: next.effort,
      overBudget: false,
      reason: `escalated from ${current} after ${input.why}: the next stronger model, by role default`,
    },
  };
}

/**
 * One profile up the step's own score (spec §5.2.5); a pinned step, the top, or the ceiling keeps it. A step
 * whose profile has no score or cost to compare on climbs the role defaults instead.
 */
export function escalateStep(
  step: WorkstreamStep,
  input: EscalateInput,
): { readonly step: WorkstreamStep; readonly escalated: boolean } {
  const current = `${step.model}@${step.effort}`;
  if (step.pinned)
    return {
      step: { ...step, reason: `kept ${current} after ${input.why}: pinned` },
      escalated: false,
    };
  const here = input.profiles.find((p) => p.id === step.profileId);
  if (here && (score(here, step.score) === null || here.costPerTaskUsd === null))
    return climbRoleDefaults(step, here, input);
  const hereScore = here ? score(here, step.score) : null;
  const level = hereScore ?? step.need;
  const stronger = measured(input.profiles.filter(automatic), step.score).filter(
    (p) => (score(p, step.score) ?? 0) > level,
  );
  const next = stronger
    .filter((p) => withinCeiling(p, input.budgetCeiling))
    .sort(preference(step.score))[0];
  if (!next) {
    const limit =
      input.budgetCeiling === null || stronger.length === 0
        ? 'no stronger profile'
        : `no stronger profile within the budget ceiling of ${dollars(input.budgetCeiling)}`;
    return {
      step: { ...step, reason: `kept ${current} after ${input.why}: ${limit}` },
      escalated: false,
    };
  }
  return {
    escalated: true,
    step: {
      ...step,
      profileId: next.id,
      model: next.model,
      effort: next.effort,
      overBudget: false,
      reason: `escalated from ${current} after ${input.why}`,
    },
  };
}
