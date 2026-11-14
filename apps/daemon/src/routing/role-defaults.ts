import { Effort, ModelTier, StepRole, type ModelProfileDto } from '@10db/contracts';
import {
  atEffort,
  automatic,
  effortLevel,
  modelsByPrice,
  TIERS,
  tierLevel,
  topModel,
  topSpan,
  type TierPool,
} from './pools';

/** The tier and effort each role runs on when no score can route it. */
export const ROLE_DEFAULT: Readonly<Record<StepRole, { tier: ModelTier; effort: Effort }>> = {
  [StepRole.Plan]: { tier: ModelTier.Capable, effort: Effort.High },
  [StepRole.PlanReview]: { tier: ModelTier.Capable, effort: Effort.High },
  [StepRole.Implement]: { tier: ModelTier.Balanced, effort: Effort.High },
  [StepRole.Review]: { tier: ModelTier.Capable, effort: Effort.High },
  [StepRole.Qa]: { tier: ModelTier.Efficient, effort: Effort.Medium },
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
    reason: `by the rigor’s fallback rung: the ${top ? 'top' : 'cheapest'} model of the ${pool.tier} tier${raised}`,
  };
}

/**
 * One rung up from a profile: the top model of its tier when it is not already there, then the cheapest model of
 * the next tier up, then, on the top of the highest, the next effort. The top of Capable is the dearest model of
 * Capable and Frontier together. A model with no tier climbs from the
 * role's tier, never downward. Undefined at the top.
 */
export function strongerDefault(
  from: Pick<ModelProfileDto, 'model' | 'effort' | 'tier'>,
  profiles: readonly ModelProfileDto[],
  roleTier: ModelTier,
): ModelProfileDto | undefined {
  const offered = profiles.filter(automatic);
  const tier = from.tier ?? roleTier;
  const span = topSpan(tier);
  const top = topModel(offered.filter((p) => p.tier !== null && span.includes(p.tier)))[0]?.model;
  if (top !== undefined && top !== from.model) return atEffort(top, from.effort, offered);
  for (const above of TIERS.slice(tierLevel(tier) + span.length)) {
    const cheapest = modelsByPrice(offered.filter((p) => p.tier === above))[0];
    if (cheapest !== undefined) return atEffort(cheapest, from.effort, offered);
  }
  return offered
    .filter((p) => p.model === from.model && effortLevel(p.effort) > effortLevel(from.effort))
    .sort((a, b) => effortLevel(a.effort) - effortLevel(b.effort))[0];
}
