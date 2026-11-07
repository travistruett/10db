import {
  ModelStatus,
  type AccountModelDto,
  type ModelProfileDto,
  type Provider,
} from '@10db/contracts';
import { modelsByPrice, tierLevel } from './pools';

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
 * The models among the profiles an account offers, each once, weakest tier first and cheapest first within
 * it: what a conversation's model picker lists. A model off for routing, or not ranked, is still one the
 * builder may choose by hand; a replaced or retired one is not.
 */
export function offeredModels(profiles: readonly ModelProfileDto[]): string[] {
  const choosable = profiles.filter(
    (p) => p.status !== ModelStatus.Superseded && p.status !== ModelStatus.Retired,
  );
  const tierOf = new Map(choosable.map((p) => [p.model, p.tier === null ? 3 : tierLevel(p.tier)]));
  return modelsByPrice(choosable).sort((a, b) => (tierOf.get(a) ?? 3) - (tierOf.get(b) ?? 3));
}
