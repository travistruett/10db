import type { AccountModelDto, ModelProfileDto, StepRole, WorkstreamStep } from '@10db/contracts';
import { costOnAccount } from './cost-on-account';
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
   * that price (`costOnAccount`); without it, or for a model it prices at nothing, with the maker's figure.
   */
  readonly accountModels?: readonly AccountModelDto[];
}

export interface RouteChoice {
  readonly profile: ModelProfileDto;
  readonly reason: string;
  readonly overBudget: boolean;
}

/** No profile can run a step: measured ones exist but none reaches its minimum score. */
export class NoProfileError extends Error {
  override name = 'NoProfileError';
}

/** No profile has a cost and an Intelligence score to compare on yet: there is nothing to route on. */
export class UnmeasuredError extends Error {
  override name = 'UnmeasuredError';
}

/** Every role routes on AA's Intelligence Index, a quarter of which is coding. */
const score = (p: ModelProfileDto): number | null => p.scores.intelligence;

function measured(profiles: readonly ModelProfileDto[]): ModelProfileDto[] {
  return profiles.filter((p) => score(p) !== null && p.costPerTaskUsd !== null);
}

const preference =
  (accountModels?: readonly AccountModelDto[]) => (a: ModelProfileDto, b: ModelProfileDto) =>
    (costOnAccount(a, accountModels) ?? 0) - (costOnAccount(b, accountModels) ?? 0) ||
    (b.outputTokensPerSecond ?? 0) - (a.outputTokensPerSecond ?? 0) ||
    (score(a) ?? 0) - (score(b) ?? 0);

const withinCeiling = (
  p: ModelProfileDto,
  ceiling: number | null,
  accountModels?: readonly AccountModelDto[],
) => ceiling === null || (costOnAccount(p, accountModels) ?? 0) <= ceiling;
const dollars = (n: number) => `$${String(n)}`;

/** The cost a reason names beside the ceiling, when the account's price made it differ from the maker's figure. */
const costNote = (p: ModelProfileDto, accountModels?: readonly AccountModelDto[]): string => {
  const cost = costOnAccount(p, accountModels);
  return cost === null || cost === p.costPerTaskUsd
    ? ''
    : ` (${dollars(Number(cost.toPrecision(6)))} a task on this account)`;
};

/** The cheapest measured profile at or above the step's need and floor, within the ceiling. */
export function route(input: RouteInput): RouteChoice {
  const candidates = measured(input.profiles);
  if (candidates.length === 0)
    throw new UnmeasuredError('No profile has an intelligence score yet');
  const minimum = Math.max(input.need, input.floor.minimum);
  const priced = input.accountModels;
  const able = candidates.filter((p) => (score(p) ?? 0) >= minimum).sort(preference(priced));
  const best = able.find((p) => withinCeiling(p, input.budgetCeiling, priced)) ?? able[0];
  if (!best) {
    if (input.shortfall === 'refuse')
      throw new NoProfileError(`No profile reaches ${String(minimum)} intelligence`);
    const strongest = [...candidates].sort(
      (a, b) => (score(b) ?? 0) - (score(a) ?? 0) || preference(priced)(a, b),
    )[0];
    if (!strongest) throw new NoProfileError(`No profile reaches ${String(minimum)} intelligence`);
    return {
      profile: strongest,
      overBudget: !withinCeiling(strongest, input.budgetCeiling, priced),
      reason: `by score: none reaches ${String(minimum)} intelligence, so the highest scoring`,
    };
  }
  const overBudget = !withinCeiling(best, input.budgetCeiling, priced);
  const floor =
    input.floor.why && input.floor.minimum > input.need ? ` (floor: ${input.floor.why})` : '';
  const budget =
    overBudget && input.budgetCeiling !== null
      ? `; over the budget ceiling of ${dollars(input.budgetCeiling)}${costNote(best, priced)}`
      : '';
  return {
    profile: best,
    overBudget,
    reason: `by score: cheapest profile at or above ${String(minimum)} intelligence${floor}${budget}`,
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
 * One profile up in intelligence (spec §5.2.5); a pinned step, the top, or the ceiling keeps it. A step
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
  if (here && (score(here) === null || here.costPerTaskUsd === null))
    return climbRoleDefaults(step, here, input);
  const hereScore = here ? score(here) : null;
  const level = hereScore ?? step.need;
  const stronger = measured(input.profiles.filter(automatic)).filter(
    (p) => (score(p) ?? 0) > level,
  );
  const next = stronger
    .filter((p) => withinCeiling(p, input.budgetCeiling, input.accountModels))
    .sort(preference(input.accountModels))[0];
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
