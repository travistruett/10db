import { Effort, ModelTier, StepRole, type ModelProfileDto } from '@10db/contracts';
import { atEffort, automatic, effortLevel, modelsByPrice, priceOf, type TierPool } from './pools';

/** The tier and effort each role runs on when no score can route it. */
export const ROLE_DEFAULT: Readonly<Record<StepRole, { tier: ModelTier; effort: Effort }>> = {
  [StepRole.Plan]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.PlanReview]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.Implement]: { tier: ModelTier.Balanced, effort: Effort.High },
  [StepRole.Review]: { tier: ModelTier.Strongest, effort: Effort.High },
  [StepRole.Qa]: { tier: ModelTier.Fast, effort: Effort.Medium },
};

export interface TierPick {
  readonly profile: ModelProfileDto;
  readonly tier: ModelTier;
  readonly reason: string;
}

/**
 * The profile a pool runs a step on when no score can route it: its cheapest model, or with `top` its most
 * expensive, at the effort or the nearest one the model offers. Undefined for an empty pool.
 */
export function pickByDefault(
  pool: TierPool,
  effort: Effort,
  top: boolean,
  raised: string,
): TierPick | undefined {
  const models = modelsByPrice(pool.profiles);
  const model = top ? models.at(-1) : models[0];
  const profile = model === undefined ? undefined : atEffort(model, effort, pool.profiles);
  if (!profile) return undefined;
  return {
    profile,
    tier: pool.tier,
    reason: `by role default: the ${top ? 'top' : 'cheapest'} model of the ${pool.tier} tier${raised}`,
  };
}

/** The tier a role runs on, which a floor moves to the strongest. */
export const defaultTier = (role: StepRole, floored: boolean): ModelTier =>
  floored ? ModelTier.Strongest : ROLE_DEFAULT[role].tier;

/**
 * One rung up from a profile: the next model that costs more at the nearest effort, then, on the dearest, the
 * next effort up. Undefined at the top.
 */
export function strongerDefault(
  from: Pick<ModelProfileDto, 'model' | 'effort' | 'outputPrice'>,
  profiles: readonly ModelProfileDto[],
): ModelProfileDto | undefined {
  const offered = profiles.filter(automatic);
  const here = priceOf(from);
  const next = modelsByPrice(offered).find(
    (model) => priceOf(offered.find((p) => p.model === model) ?? { outputPrice: null }) > here,
  );
  if (next !== undefined) return atEffort(next, from.effort, offered);
  return offered
    .filter((p) => p.model === from.model && effortLevel(p.effort) > effortLevel(from.effort))
    .sort((a, b) => effortLevel(a.effort) - effortLevel(b.effort))[0];
}
