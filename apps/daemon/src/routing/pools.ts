import { Effort, ModelTier, type ModelProfileDto } from '@10db/contracts';

/** Tiers, weakest first. */
export const TIERS: readonly ModelTier[] = [
  ModelTier.Efficient,
  ModelTier.Balanced,
  ModelTier.Capable,
  ModelTier.Frontier,
];
const EFFORTS: readonly Effort[] = Object.values(Effort);

export const tierLevel = (tier: ModelTier): number => TIERS.indexOf(tier);

/**
 * The tiers whose models a top pick from the tier chooses among. Capable and Frontier split what was one
 * strongest tier, so the top of Capable is still the dearest model of both.
 */
export const topSpan = (tier: ModelTier): readonly ModelTier[] =>
  tier === ModelTier.Capable ? [ModelTier.Capable, ModelTier.Frontier] : [tier];
export const effortLevel = (effort: Effort): number => EFFORTS.indexOf(effort);

/** The effort one step above, or the same at the top. */
export const effortAbove = (effort: Effort): Effort =>
  EFFORTS[Math.min(effortLevel(effort) + 1, EFFORTS.length - 1)] ?? effort;

/** What a model costs to run, for ordering: its output price, nothing when the maker lists none. */
export const priceOf = (profile: Pick<ModelProfileDto, 'outputPrice'>): number =>
  profile.outputPrice ?? 0;

/**
 * Whether routing may pick the profile by itself: it is on, and its model is ranked into a tier. An Unknown,
 * Superseded or Retired model is never picked unasked.
 */
export const automatic = (profile: ModelProfileDto): boolean =>
  profile.enabled && profile.tier !== null;

/** The distinct models of the profiles, cheapest first, by output price and then by name. */
export function modelsByPrice(profiles: readonly ModelProfileDto[]): string[] {
  const price = new Map<string, number>();
  for (const p of profiles) price.set(p.model, priceOf(p));
  return [...price.keys()].sort(
    (a, b) => (price.get(a) ?? 0) - (price.get(b) ?? 0) || a.localeCompare(b),
  );
}

/** The profiles of the model that costs most. */
export function topModel(profiles: readonly ModelProfileDto[]): ModelProfileDto[] {
  const top = modelsByPrice(profiles).at(-1);
  return profiles.filter((p) => p.model === top);
}

/** The model's profile at the effort, else at the nearest effort offered, the higher on a tie. */
export function atEffort(
  model: string,
  effort: Effort,
  offered: readonly ModelProfileDto[],
): ModelProfileDto | undefined {
  const target = effortLevel(effort);
  const distance = (p: ModelProfileDto) => Math.abs(effortLevel(p.effort) - target);
  return offered
    .filter((p) => p.model === model)
    .sort((a, b) => distance(a) - distance(b) || effortLevel(b.effort) - effortLevel(a.effort))[0];
}

export interface TierPool {
  /** The tier the pool is of: the one asked for, or the nearest the account offers. */
  readonly tier: ModelTier;
  readonly profiles: readonly ModelProfileDto[];
}

/** The pool, with the models of every tier its top pick spans (`topSpan`). */
export function withTopSpan(pool: TierPool, profiles: readonly ModelProfileDto[]): TierPool {
  const span = topSpan(pool.tier);
  if (span.length === 1) return pool;
  return {
    tier: pool.tier,
    profiles: profiles.filter((p) => automatic(p) && p.tier !== null && span.includes(p.tier)),
  };
}

/**
 * The profiles routing may pick in the tier, else in the nearest stronger tier the account offers, else the
 * nearest weaker one. Undefined when the account offers nothing routing may pick.
 */
export function tierPool(
  tier: ModelTier,
  profiles: readonly ModelProfileDto[],
): TierPool | undefined {
  const pickable = profiles.filter(automatic);
  const target = tierLevel(tier);
  const present = new Set<ModelTier>();
  for (const p of pickable) if (p.tier !== null) present.add(p.tier);
  const byLevel = [...present].sort((a, b) => tierLevel(a) - tierLevel(b));
  const nearest =
    byLevel.find((t) => tierLevel(t) >= target) ??
    byLevel.filter((t) => tierLevel(t) < target).at(-1);
  return nearest === undefined
    ? undefined
    : { tier: nearest, profiles: pickable.filter((p) => p.tier === nearest) };
}
