import {
  ROLE_SCORE,
  ScoreKind,
  type AccountModelDto,
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
  /**
   * The account's own list. Where it prices a model, the ceiling is compared with the cost per task scaled to
   * that price (`costOn`); without it, or for a model it prices at nothing, with the maker's figure.
   */
  readonly accountModels?: readonly AccountModelDto[];
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

/**
 * What a task costs on the account, for comparing with the budget ceiling. AA's cost per task is at the maker's
 * list price; an account that pays per token and prices its own copy of the model differently scales it by its
 * output price over the maker's. An account with no price of its own (a subscription, where a ceiling measures how
 * heavy a model is), a model the account does not list, or one with no maker price keeps the maker's figure.
 */
function costOn(
  p: ModelProfileDto,
  accountModels: readonly AccountModelDto[] | undefined,
): number | null {
  if (p.costPerTaskUsd === null) return null;
  const own = accountModels?.find((m) => m.model === p.model)?.outputPrice ?? null;
  if (own === null || p.outputPrice === null || p.outputPrice === 0) return p.costPerTaskUsd;
  return p.costPerTaskUsd * (own / p.outputPrice);
}

const preference =
  (kind: ScoreKind, accountModels?: readonly AccountModelDto[]) =>
  (a: ModelProfileDto, b: ModelProfileDto) =>
    (costOn(a, accountModels) ?? 0) - (costOn(b, accountModels) ?? 0) ||
    (b.outputTokensPerSecond ?? 0) - (a.outputTokensPerSecond ?? 0) ||
    (score(a, kind) ?? 0) - (score(b, kind) ?? 0);

const withinCeiling = (
  p: ModelProfileDto,
  ceiling: number | null,
  accountModels?: readonly AccountModelDto[],
) => ceiling === null || (costOn(p, accountModels) ?? 0) <= ceiling;
const dollars = (n: number) => `$${String(n)}`;

/** The cost a reason names beside the ceiling, when the account's price made it differ from the maker's figure. */
const costNote = (p: ModelProfileDto, accountModels?: readonly AccountModelDto[]): string => {
  const cost = costOn(p, accountModels);
  return cost === null || cost === p.costPerTaskUsd
    ? ''
    : ` (${dollars(Number(cost.toPrecision(6)))} a task on this account)`;
};

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
  const priced = input.accountModels;
  const able = candidates
    .filter((p) => (score(p, kind) ?? 0) >= minimum)
    .sort(preference(kind, priced));
  const best = able.find((p) => withinCeiling(p, input.budgetCeiling, priced)) ?? able[0];
  if (!best) {
    if (input.shortfall === 'refuse')
      throw new NoProfileError(`No profile reaches ${String(minimum)} ${kind}`);
    const strongest = [...candidates].sort(
      (a, b) => (score(b, kind) ?? 0) - (score(a, kind) ?? 0) || preference(kind, priced)(a, b),
    )[0];
    if (!strongest) throw new NoProfileError(`No profile reaches ${String(minimum)} ${kind}`);
    return {
      profile: strongest,
      score: kind,
      overBudget: !withinCeiling(strongest, input.budgetCeiling, priced),
      reason: `by score: none reaches ${String(minimum)} ${kind}, so the highest scoring`,
    };
  }
  const overBudget = !withinCeiling(best, input.budgetCeiling, priced);
  const fellBack = kind === own ? '' : ` (AA gives no ${own} score; compared on ${kind})`;
  const floor =
    input.floor.why && input.floor.minimum > input.need ? ` (floor: ${input.floor.why})` : '';
  const budget =
    overBudget && input.budgetCeiling !== null
      ? `; over the budget ceiling of ${dollars(input.budgetCeiling)}${costNote(best, priced)}`
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
  /** The account's own list, as on `RouteInput`. */
  readonly accountModels?: readonly AccountModelDto[];
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
    .filter((p) => withinCeiling(p, input.budgetCeiling, input.accountModels))
    .sort(preference(step.score, input.accountModels))[0];
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
