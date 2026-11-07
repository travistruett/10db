import {
  ModelStatus,
  type AccountModelDto,
  type ModelProfileDto,
  type Provider,
  type ShapeModelOption,
} from '@10db/contracts';
import { modelsByPrice, TIERS, tierLevel } from './pools';

/**
 * The profiles an account offers: those of a model it lists, at an effort it lists (every effort when it lists
 * none for the model), leaving out a model marked unusable. An account that has not listed its models yet is
 * assumed to offer every profile of its provider.
 */
export function offeredProfiles(
  profiles: readonly ModelProfileDto[],
  accountModels: readonly AccountModelDto[],
  provider: Provider,
): ModelProfileDto[] {
  const ofProvider = profiles.filter((p) => p.provider === provider);
  if (accountModels.length === 0) return ofProvider;
  const listed = new Map(accountModels.map((m) => [m.model, m]));
  return ofProvider.filter((p) => {
    const offer = listed.get(p.model);
    return (
      offer !== undefined &&
      !offer.unusable &&
      (offer.efforts.length === 0 || offer.efforts.includes(p.effort))
    );
  });
}

/**
 * The models among the profiles an account offers, each once with its tier, weakest tier first and cheapest
 * first within it: what a conversation's model picker lists. It is the account's whole list, a replaced
 * model and one the catalogue does not rank (last) included, because the builder may choose any by hand;
 * only a model its maker has retired is left out.
 */
export function offeredModels(profiles: readonly ModelProfileDto[]): ShapeModelOption[] {
  const choosable = profiles.filter((p) => p.status !== ModelStatus.Retired);
  const tiers = new Map(choosable.map((p) => [p.model, p.tier]));
  const level = (model: string): number => {
    const tier = tiers.get(model) ?? null;
    return tier === null ? TIERS.length : tierLevel(tier);
  };
  return modelsByPrice(choosable)
    .sort((a, b) => level(a) - level(b))
    .map((model) => ({ model, tier: tiers.get(model) ?? null }));
}
