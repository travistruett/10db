import { ModelStatus, ModelTier } from '@10db/contracts';
import type { CatalogueModel } from './source';

/** A tier is this share of the maker's top output price, or more. */
const STRONGEST_FROM = 0.3;
/** A tier is this share of the maker's top output price, or less. */
const FAST_UP_TO = 0.1;

export interface DerivedTier {
  tier: ModelTier | null;
  status: ModelStatus;
}

/** A model with a maker and a price, the only kind that can be ranked. */
type Ranked = CatalogueModel & { maker: string; outputPrice: number };

const rankable = (m: CatalogueModel): m is Ranked =>
  m.maker !== null && m.outputPrice !== null && m.outputPrice > 0;

/**
 * Tiers from output price, for the offered models only. Within a maker's family only the newest model is
 * ranked, the older ones are Superseded; the rest are compared with the maker's most expensive model
 * left. A model with no price is Unknown and a deprecated one is Retired; neither is ranked.
 */
export function deriveTiers(
  models: readonly CatalogueModel[],
  offered: ReadonlySet<string>,
): Map<string, DerivedTier> {
  const result = new Map<string, DerivedTier>();
  const live: Ranked[] = [];
  for (const m of models) {
    if (!offered.has(m.id)) continue;
    if (m.deprecated) result.set(m.id, { tier: null, status: ModelStatus.Retired });
    else if (rankable(m)) live.push(m);
    else result.set(m.id, { tier: null, status: ModelStatus.Unknown });
  }

  const familyKey = (m: CatalogueModel): string => JSON.stringify([m.maker, m.family]);
  const newest = new Map<string, string>();
  for (const m of live) {
    if (m.family === null || m.releaseDate === null) continue;
    const seen = newest.get(familyKey(m));
    if (seen === undefined || m.releaseDate > seen) newest.set(familyKey(m), m.releaseDate);
  }

  const topByMaker = new Map<string, number>();
  const ranked: Ranked[] = [];
  for (const m of live) {
    const latest = m.family === null ? undefined : newest.get(familyKey(m));
    if (latest !== undefined && m.releaseDate !== null && m.releaseDate < latest) {
      result.set(m.id, { tier: null, status: ModelStatus.Superseded });
      continue;
    }
    ranked.push(m);
    topByMaker.set(m.maker, Math.max(topByMaker.get(m.maker) ?? 0, m.outputPrice));
  }

  for (const m of ranked) {
    const share = m.outputPrice / (topByMaker.get(m.maker) ?? m.outputPrice);
    const tier =
      share >= STRONGEST_FROM
        ? ModelTier.Strongest
        : share <= FAST_UP_TO
          ? ModelTier.Fast
          : ModelTier.Balanced;
    result.set(m.id, { tier, status: ModelStatus.Current });
  }
  return result;
}
